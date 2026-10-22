//! AIRLOCK Stage 0B repair: protected signing gate.
//!
//! Trust boundary:
//! - Trusted operator: `approve`, `approvals`, `validate`, `sign`, `fixture`,
//!   and `serve` are operator-side commands. They require readable wallet +
//!   identity configuration and read/write access to the gate home.
//! - Untrusted proposer: reaches signing only through `submit`, which speaks a
//!   fixed Unix-socket protocol carrying an approval ID and PCZT bytes. It
//!   accepts no wallet, identity, gate-home, or output-path configuration and
//!   has no request type for creating or abandoning approvals.
//! - The OS boundary (separate UID or an equivalent mount-namespace sandbox)
//!   is what prevents the proposer from reading the gate home, wallet, or
//!   identity. Same-UID arbitrary code is NOT defended against; see
//!   `STAGE0B_REPAIR.md`.

use std::{
    fs,
    io::{self, Read, Write},
    os::unix::{
        fs::{FileTypeExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::Command as Proc,
    time::Duration,
};

use anyhow::anyhow;
use clap::{Args, Subcommand};
use pczt::Pczt;

use self::approval::{
    Approval, ApprovalStatus, ApprovalStore, MemoPolicy, ReserveOutcome, canonical_empty_memo,
    canonical_text_memo, now_unix,
};
use self::validate::{
    GateError, Stage, load_keys, sign_validated, validate,
};

pub(crate) mod approval;
pub(crate) mod fixture;
pub(crate) mod validate;

const IPV_VERSION: u8 = 1;
const REQ_MAGIC: [u8; 4] = *b"ALG1";
const RESP_MAGIC: [u8; 4] = *b"ALR1";
const MAX_ID_BYTES: usize = 64;
const MAX_PCZT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 2048;

#[derive(Debug, Args)]
pub(crate) struct Command {
    #[command(subcommand)]
    command: GateSub,
}

#[derive(Debug, Subcommand)]
pub(crate) enum GateSub {
    /// Create a single-payment approval (operator only).
    Approve(ApproveCmd),
    /// List or abandon approvals (operator only).
    Approvals(ApprovalsCmd),
    /// Sign a proposal with full local configuration (operator only).
    Sign(SignCmd),
    /// Validate a proposal without signing (operator only).
    Validate(ValidateCmd),
    /// Serve the restricted proposer interface over a Unix socket (operator only).
    Serve(ServeCmd),
    /// Submit a proposal to a running gate (restricted proposer interface).
    Submit(SubmitCmd),
    /// Test-only fixture helpers; require AIRLOCK_GATE_TEST_FIXTURES=1.
    Fixture(fixture::FixtureCmd),
}

#[derive(Debug, Args)]
pub(crate) struct ApproveCmd {
    /// Path to the gate home directory (approvals, MAC key, audit log).
    /// Defaults to $AIRLOCK_GATE_HOME or ~/.airlock-gate.
    #[arg(long)]
    gate_home: Option<PathBuf>,
    /// Unique approval ID (bounded allowlist, immutable once created).
    #[arg(long)]
    id: String,
    /// Recipient unified address (testnet).
    #[arg(long)]
    recipient: String,
    /// Exact amount in zatoshis.
    #[arg(long)]
    amount: u64,
    /// Maximum fee in zatoshis the gate will accept.
    #[arg(long)]
    max_fee: u64,
    /// Memo policy: `exact:<text>` or `empty`.
    #[arg(long)]
    memo_policy: String,
    /// Approval lifetime in seconds from now.
    #[arg(long, default_value_t = 3600)]
    expires_in: u64,
}

#[derive(Debug, Args)]
pub(crate) struct ApprovalsCmd {
    #[arg(long)]
    gate_home: Option<PathBuf>,
    #[command(subcommand)]
    command: ApprovalsSub,
}

#[derive(Debug, Subcommand)]
pub(crate) enum ApprovalsSub {
    List,
    /// Trusted recovery: abandon a pending/reserved approval.
    Abandon {
        id: String,
        /// Allow abandoning even if a signed artifact exists. The bound txid is
        /// retained, so the approval can never authorize a different payment.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SignCmd {
    #[arg(long)]
    gate_home: Option<PathBuf>,
    #[arg(long)]
    wallet: PathBuf,
    #[arg(long)]
    identity: PathBuf,
    #[arg(long)]
    proposal: PathBuf,
    #[arg(long)]
    approval_id: String,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Debug, Args)]
pub(crate) struct ValidateCmd {
    #[arg(long)]
    gate_home: Option<PathBuf>,
    #[arg(long)]
    wallet: PathBuf,
    #[arg(long)]
    identity: PathBuf,
    #[arg(long)]
    proposal: PathBuf,
    #[arg(long)]
    approval_id: String,
}

#[derive(Debug, Args)]
pub(crate) struct ServeCmd {
    #[arg(long)]
    gate_home: Option<PathBuf>,
    #[arg(long)]
    wallet: PathBuf,
    #[arg(long)]
    identity: PathBuf,
    /// Operator-chosen socket path in a directory the proposer can reach
    /// (e.g. /run/airlock/gate.sock). Mode 0660 is applied.
    #[arg(long)]
    socket: PathBuf,
}

/// Restricted proposer interface: no wallet/identity/gate-home/output flags.
#[derive(Debug, Args)]
pub(crate) struct SubmitCmd {
    #[arg(long)]
    socket: PathBuf,
    #[arg(long)]
    approval_id: String,
    #[arg(long)]
    proposal: PathBuf,
    /// Proposer-side output path; defaults to stdout. Absolute server-side
    /// paths are never accepted by the gate.
    #[arg(long)]
    output: Option<PathBuf>,
}

fn resolve_gate_home(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(p) = explicit {
        return p;
    }
    if let Ok(p) = std::env::var("AIRLOCK_GATE_HOME") {
        return PathBuf::from(p);
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".airlock-gate")
}

fn fixtures_enabled() -> bool {
    std::env::var("AIRLOCK_GATE_TEST_FIXTURES").as_deref() == Ok("1")
}

fn parse_memo_policy(s: &str) -> Result<(MemoPolicy, [u8; 512]), anyhow::Error> {
    let policy = if s == "empty" {
        MemoPolicy::Empty
    } else if let Some(t) = s.strip_prefix("exact:") {
        MemoPolicy::Exact(t.to_string())
    } else {
        anyhow::bail!("memo-policy must be `empty` or `exact:<text>`")
    };
    let canonical = match &policy {
        MemoPolicy::Exact(text) => canonical_text_memo(text)?,
        MemoPolicy::Empty => canonical_empty_memo(),
    };
    Ok((policy, canonical))
}

struct GateContext {
    keys: validate::GateKeys,
    params: crate::data::Network,
    wallet: PathBuf,
}

impl GateContext {
    fn load(wallet: &Path, identity: &Path) -> Result<Self, anyhow::Error> {
        let config = crate::config::WalletConfig::read(Some(wallet))?;
        if !matches!(config.network(), crate::data::Network::Test) {
            return Err(anyhow::Error::new(GateError::new(
                "E_WALLET_NETWORK",
                Stage::Scope,
                "trusted wallet is not configured for testnet",
            )));
        }
        let params = crate::data::Network::Test;
        let keys = load_keys(wallet, identity, &params)?;
        Ok(Self {
            keys,
            params,
            wallet: wallet.to_path_buf(),
        })
    }

    /// A trustworthy local chain tip is mandatory. There is no "skip check"
    /// path: if the wallet cannot report a positive tip, signing is refused.
    fn require_tip(&self) -> Result<u32, anyhow::Error> {
        if fixtures_enabled()
            && std::env::var("AIRLOCK_GATE_TEST_FORCE_TIP_UNAVAILABLE").as_deref() == Ok("1")
        {
            return Err(anyhow::Error::new(GateError::new(
                "E_TIP_UNAVAILABLE",
                Stage::Expiry,
                "chain tip unavailable (forced by test fixture)",
            )));
        }
        match tip_via_devtool(&self.wallet) {
            Some(tip) if tip > 0 => Ok(tip),
            _ => Err(anyhow::Error::new(GateError::new(
                "E_TIP_UNAVAILABLE",
                Stage::Expiry,
                "local wallet chain tip unavailable; refusing to sign",
            ))),
        }
    }
}

impl Command {
    pub(crate) async fn run(self) -> Result<(), anyhow::Error> {
        match self.command {
            GateSub::Approve(c) => run_approve(c),
            GateSub::Approvals(c) => run_approvals(c),
            GateSub::Sign(c) => run_sign(c),
            GateSub::Validate(c) => run_validate(c),
            GateSub::Serve(c) => run_serve(c),
            GateSub::Submit(c) => run_submit(c),
            GateSub::Fixture(c) => {
                let home = resolve_gate_home(c.gate_home.clone());
                let store = ApprovalStore::open(&home)?;
                let wallet = c.wallet.clone();
                fixture::run(c, &store, wallet.as_deref(), None)
            }
        }
    }
}

fn run_approve(c: ApproveCmd) -> Result<(), anyhow::Error> {
    let home = resolve_gate_home(c.gate_home);
    let store = ApprovalStore::open(&home)?;
    let (policy, canonical) = parse_memo_policy(&c.memo_policy)?;
    let approval = Approval {
        id: c.id.clone(),
        network: "test".to_string(),
        recipient_ua: c.recipient,
        amount_zatoshis: c.amount,
        max_fee_zatoshis: c.max_fee,
        memo_policy: policy,
        memo_canonical_hex: Some(hex::encode(canonical)),
        expires_at_unix: now_unix() + c.expires_in,
        single_payment: true,
        bound_txid: None,
        status: ApprovalStatus::Pending,
        signed_artifact: None,
        created_at_unix: 0,
        updated_at_unix: 0,
    };
    let a = store.create(approval)?;
    store.append_audit(&format!(
        "APPROVE id={} amount={} max_fee={} recipient={} expires_at={} memo_bytes={}",
        a.id,
        a.amount_zatoshis,
        a.max_fee_zatoshis,
        a.recipient_ua,
        a.expires_at_unix,
        a.memo_canonical_hex.as_deref().map(str::len).unwrap_or(0) / 2
    ));
    println!(
        "APPROVED id={} amount_zat={} max_fee_zat={} memo_policy={:?} expires_at={}",
        a.id, a.amount_zatoshis, a.max_fee_zatoshis, a.memo_policy, a.expires_at_unix
    );
    Ok(())
}

fn run_approvals(c: ApprovalsCmd) -> Result<(), anyhow::Error> {
    let home = resolve_gate_home(c.gate_home);
    let store = ApprovalStore::open(&home)?;
    match c.command {
        ApprovalsSub::List => {
            for a in store.list()? {
                println!(
                    "{} status={:?} amount={} max_fee={} bound={:?} artifact={:?} expires_at={}",
                    a.id,
                    a.status,
                    a.amount_zatoshis,
                    a.max_fee_zatoshis,
                    a.bound_txid,
                    a.signed_artifact,
                    a.expires_at_unix
                );
            }
            Ok(())
        }
        ApprovalsSub::Abandon { id, force } => {
            store.abandon(&id, force)?;
            store.append_audit(&format!("ABANDON id={id} force={force}"));
            println!("ABANDONED id={id}");
            Ok(())
        }
    }
}

fn run_validate(c: ValidateCmd) -> Result<(), anyhow::Error> {
    let home = resolve_gate_home(c.gate_home);
    let store = ApprovalStore::open(&home)?;
    let ctx = GateContext::load(&c.wallet, &c.identity)?;
    let bytes = read_proposal(&c.proposal)?;
    let pczt = Pczt::parse(&bytes)
        .map_err(|e| gate_err("E_PARSE", Stage::Parse, format!("{e:?}")))?;
    let (approval, _) = store.load(&c.approval_id)?;
    let tip = ctx.require_tip()?;
    let v = validate(&pczt, &approval, &ctx.keys, &ctx.params, tip)?;
    store.append_audit(&format!(
        "VALIDATE id={} proposal_sha256={} fee={} signable={:?} => OK",
        c.approval_id,
        sha256_hex(&bytes),
        v.fee_zatoshis,
        v.signable_spends
    ));
    println!(
        "VALIDATE_OK fee_zat={} signable_spends={:?} change={:?} memo=exact-bytes",
        v.fee_zatoshis, v.signable_spends, v.change_indices
    );
    Ok(())
}

fn run_sign(c: SignCmd) -> Result<(), anyhow::Error> {
    let home = resolve_gate_home(c.gate_home);
    let store = ApprovalStore::open(&home)?;
    let ctx = GateContext::load(&c.wallet, &c.identity)?;
    let bytes = read_proposal(&c.proposal)?;
    // Reject an unsafe output path before any signature is produced.
    check_output_path(&c.output)?;
    let out = sign_core(&ctx, &store, &bytes, &c.approval_id)?;
    write_output_file(&c.output, &out.bytes)?;
    let code = if out.recovered {
        "SIGN_RECOVERED_OK"
    } else {
        "SIGN_OK"
    };
    match out.fee_zatoshis {
        Some(fee) => println!(
            "{code} approval={} txid={} verified_spends={:?} fee_zat={}",
            c.approval_id, out.txid, out.verified, fee
        ),
        None => println!(
            "{code} approval={} txid={} (retained artifact)",
            c.approval_id, out.txid
        ),
    }
    Ok(())
}

struct SignedOutcome {
    txid: String,
    bytes: Vec<u8>,
    verified: Vec<usize>,
    fee_zatoshis: Option<u64>,
    recovered: bool,
}

fn sign_core(
    ctx: &GateContext,
    store: &ApprovalStore,
    bytes: &[u8],
    approval_id: &str,
) -> Result<SignedOutcome, anyhow::Error> {
    approval::validate_id(approval_id)?;
    let input_sha = sha256_hex(bytes);
    let pczt = Pczt::parse(bytes)
        .map_err(|e| gate_err("E_PARSE", Stage::Parse, format!("{e:?}")))?;
    let txid = txid_of(&pczt)?;

    // Serialize all transitions for this approval (create/abandon are
    // serialized by the same lock).
    let _lock = store.lock(approval_id)?;
    let (approval, _) = store.load(approval_id)?;

    match approval.status {
        ApprovalStatus::Abandoned => {
            return Err(gate_err(
                "E_AUTH_CONSUMED",
                Stage::Authorization,
                "approval abandoned",
            ))
        }
        ApprovalStatus::Completed => {
            if approval.bound_txid.as_deref() != Some(txid.as_str()) {
                return Err(gate_err(
                    "E_AUTH_CONSUMED",
                    Stage::Authorization,
                    "approval already committed to a different payment",
                ));
            }
            let artifact = load_verified_artifact(store, &txid)?;
            store.append_audit(&format!(
                "SIGN_RETRY id={approval_id} txid={txid} bytes={}",
                artifact.len()
            ));
            return Ok(SignedOutcome {
                txid,
                bytes: artifact,
                verified: Vec::new(),
                fee_zatoshis: None,
                recovered: true,
            });
        }
        ApprovalStatus::Reserved => {
            if approval.bound_txid.as_deref() != Some(txid.as_str()) {
                return Err(gate_err(
                    "E_AUTH_CONSUMED",
                    Stage::Authorization,
                    "approval already bound to another transaction",
                ));
            }
            // Bounded restart recovery for the SAME bound transaction: a
            // persisted artifact means signing already happened; never re-sign.
            if store.artifact_exists(&txid)? {
                let artifact = load_verified_artifact(store, &txid)?;
                store.mark_completed(approval_id, &txid, &ApprovalStore::artifact_name(&txid))?;
                store.append_audit(&format!(
                    "SIGN_RECOVERED id={approval_id} txid={txid} bytes={}",
                    artifact.len()
                ));
                return Ok(SignedOutcome {
                    txid,
                    bytes: artifact,
                    verified: Vec::new(),
                    fee_zatoshis: None,
                    recovered: true,
                });
            }
            // No persisted signature: resume validation/signing for this txid.
        }
        ApprovalStatus::Pending => {
            // Artifacts are keyed by txid and may legitimately exist because a
            // different approval already signed the same transaction. A pending
            // approval has no persisted signature of its own; signing is safe
            // and overwrites the artifact with an equivalent one for the same
            // txid.
        }
    }

    let tip = ctx.require_tip()?;
    let validated = validate(&pczt, &approval, &ctx.keys, &ctx.params, tip)?;

    let mut reserved = false;
    if approval.status == ApprovalStatus::Pending {
        match store.try_reserve(approval_id, &txid)? {
            ReserveOutcome::Acquired => reserved = true,
            ReserveOutcome::SameTx => {}
        }
    }
    crash_point("reserve");
    store.append_audit(&format!(
        "RESERVE id={approval_id} txid={txid} input_sha256={input_sha} recovered={}",
        !reserved
    ));

    // Sign the same in-memory object that was validated.
    let (signed, verified) = match sign_validated(pczt, &ctx.keys, &validated) {
        Ok(r) => r,
        Err(e) => {
            store.append_audit(&format!(
                "SIGN_FAIL id={approval_id} txid={txid} reason={}",
                e.reason
            ));
            return Err(anyhow::Error::new(e));
        }
    };

    let signed_bytes = signed
        .serialize()
        .map_err(|e| gate_err("E_SERIALIZE", Stage::Signing, format!("{e:?}")))?;
    crash_point("artifact");
    // Durability order: artifact first, then completion record, then success.
    store.write_artifact(&txid, &signed_bytes)?;
    crash_point("complete");
    let artifact_name = ApprovalStore::artifact_name(&txid);
    store.mark_completed(approval_id, &txid, &artifact_name)?;
    store.append_audit(&format!(
        "SIGN_OK id={approval_id} txid={txid} verified_spends={verified:?} fee={} bytes={}",
        validated.fee_zatoshis,
        signed_bytes.len()
    ));
    Ok(SignedOutcome {
        txid,
        bytes: signed_bytes,
        verified,
        fee_zatoshis: Some(validated.fee_zatoshis),
        recovered: false,
    })
}

fn load_verified_artifact(store: &ApprovalStore, txid: &str) -> Result<Vec<u8>, anyhow::Error> {
    let bytes = store.read_artifact(txid)?;
    let pczt = Pczt::parse(&bytes)
        .map_err(|_| gate_err("E_STATE_CORRUPT", Stage::Authorization, "artifact unparsable"))?;
    let actual = txid_of(&pczt)?;
    if actual != txid {
        return Err(gate_err(
            "E_STATE_CORRUPT",
            Stage::Authorization,
            "artifact txid does not match approval binding",
        ));
    }
    Ok(bytes)
}

fn txid_of(pczt: &Pczt) -> Result<String, anyhow::Error> {
    use zcash_primitives::transaction::txid::{TxIdDigester, to_txid};
    let effects = pczt
        .clone()
        .into_effects()
        .map_err(|e| gate_err("E_BIND", Stage::Parse, format!("{e:?}")))?;
    let txid_parts = effects.digest(TxIdDigester);
    Ok(to_txid(
        effects.version(),
        effects.consensus_branch_id(),
        &txid_parts,
    )
    .to_string())
}

fn read_proposal(path: &Path) -> Result<Vec<u8>, anyhow::Error> {
    let md = fs::symlink_metadata(path).map_err(|e| anyhow!("proposal unreadable: {}", e.kind()))?;
    if md.file_type().is_symlink() {
        return Err(gate_err(
            "E_PATH_UNSAFE",
            Stage::Parse,
            "proposal path must not be a symlink",
        ));
    }
    if md.len() > MAX_PCZT_BYTES as u64 {
        return Err(gate_err("E_PARSE", Stage::Parse, "proposal too large"));
    }
    fs::read(path).map_err(|e| anyhow!("proposal unreadable: {}", e.kind()))
}

fn check_output_path(path: &Path) -> Result<(), anyhow::Error> {
    if let Ok(md) = fs::symlink_metadata(path) {
        if md.file_type().is_symlink() {
            return Err(gate_err(
                "E_PATH_UNSAFE",
                Stage::Signing,
                "output path must not be a symlink",
            ));
        }
        if md.is_dir() {
            return Err(gate_err(
                "E_PATH_UNSAFE",
                Stage::Signing,
                "output path is a directory",
            ));
        }
    }
    Ok(())
}

fn write_output_file(path: &Path, bytes: &[u8]) -> Result<(), anyhow::Error> {
    check_output_path(path)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".airlock-out-{}-{}",
        std::process::id(),
        now_unix()
    ));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| anyhow!("output unreadable: {}", e.kind()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        anyhow!("output write failed: {}", e.kind())
    })?;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    Ok(())
}

fn run_serve(c: ServeCmd) -> Result<(), anyhow::Error> {
    let home = resolve_gate_home(c.gate_home);
    let store = ApprovalStore::open(&home)?;
    let ctx = GateContext::load(&c.wallet, &c.identity)?;
    let listener = bind_socket(&c.socket)?;
    println!("SERVE_READY socket={}", c.socket.display());
    store.append_audit(&format!(
        "SERVE_START socket={} wallet={} gate_home={}",
        c.socket.display(),
        c.wallet.display(),
        home.display()
    ));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(e) = handle_connection(stream, &store, &ctx) {
                    eprintln!("SUBMIT_INTERNAL {e:#}");
                }
            }
            Err(e) => eprintln!("ACCEPT_ERR {}", e.kind()),
        }
    }
    Ok(())
}

fn bind_socket(path: &Path) -> Result<UnixListener, anyhow::Error> {
    if let Ok(md) = fs::symlink_metadata(path) {
        if !md.file_type().is_socket() {
            return Err(gate_err(
                "E_PATH_UNSAFE",
                Stage::Parse,
                "socket path exists and is not a socket",
            ));
        }
        if UnixStream::connect(path).is_ok() {
            anyhow::bail!("gate socket already in use");
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)
        .map_err(|e| anyhow!("cannot bind socket: {}", e.kind()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
    Ok(listener)
}

fn handle_connection(
    mut stream: UnixStream,
    store: &ApprovalStore,
    ctx: &GateContext,
) -> Result<(), anyhow::Error> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let (id, bytes) = match read_request(&mut stream) {
        Ok(v) => v,
        Err(e) => {
            let _ = write_response(&mut stream, false, "E_PARSE", &format!("bad request: {e}"), &[]);
            return Ok(());
        }
    };
    store.append_audit(&format!(
        "SUBMIT id={id} bytes={} sha256={}",
        bytes.len(),
        sha256_hex(&bytes)
    ));
    match sign_core(ctx, store, &bytes, &id) {
        Ok(out) => {
            let code = if out.recovered {
                "SIGN_RECOVERED_OK"
            } else {
                "SIGN_OK"
            };
            store.append_audit(&format!(
                "SUBMIT_OK id={id} txid={} recovered={} bytes={}",
                out.txid,
                out.recovered,
                out.bytes.len()
            ));
            write_response(
                &mut stream,
                true,
                code,
                &format!("txid={} approved=true", out.txid),
                &out.bytes,
            )?;
        }
        Err(e) => {
            // Only gate errors (already path-sanitized) are exposed to the
            // proposer; everything else is logged operator-side.
            let (code, message) = match e.downcast_ref::<GateError>() {
                Some(g) => (g.reason, g.detail.clone()),
                None => {
                    eprintln!("SUBMIT_INTERNAL {e:#}");
                    ("E_INTERNAL", "internal error".to_string())
                }
            };
            store.append_audit(&format!("SUBMIT_ERR id={id} code={code}"));
            write_response(&mut stream, false, code, &message, &[])?;
        }
    }
    Ok(())
}

fn run_submit(c: SubmitCmd) -> Result<(), anyhow::Error> {
    approval::validate_id(&c.approval_id)?;
    if let Some(path) = &c.output {
        check_output_path(path)?;
    }
    let bytes = read_proposal(&c.proposal)?;
    let mut stream = UnixStream::connect(&c.socket)
        .map_err(|e| anyhow!("cannot connect to gate socket: {}", e.kind()))?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    write_request(&mut stream, &c.approval_id, &bytes)?;
    let (ok, code, message, artifact) = read_response(&mut stream)?;
    if !ok {
        return Err(anyhow!("{code}: {message}"));
    }
    match &c.output {
        Some(path) => {
            write_output_file(path, &artifact)?;
            println!("{code} approval={} {message}", c.approval_id);
        }
        None => {
            let mut stdout = io::stdout();
            stdout.write_all(&artifact)?;
            stdout.flush()?;
            eprintln!("{code} approval={} {message}", c.approval_id);
        }
    }
    Ok(())
}

fn write_request<W: Write>(w: &mut W, id: &str, pczt: &[u8]) -> io::Result<()> {
    if id.len() > MAX_ID_BYTES || pczt.len() > MAX_PCZT_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "request too large"));
    }
    w.write_all(&REQ_MAGIC)?;
    w.write_all(&[IPV_VERSION])?;
    w.write_all(&(id.len() as u16).to_le_bytes())?;
    w.write_all(id.as_bytes())?;
    w.write_all(&(pczt.len() as u32).to_le_bytes())?;
    w.write_all(pczt)?;
    w.flush()
}

fn read_request<R: Read>(r: &mut R) -> Result<(String, Vec<u8>), anyhow::Error> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if magic != REQ_MAGIC {
        anyhow::bail!("bad magic");
    }
    let mut version = [0u8; 1];
    r.read_exact(&mut version)?;
    if version[0] != IPV_VERSION {
        anyhow::bail!("unsupported protocol version");
    }
    let id_len = read_u16(r)? as usize;
    if id_len == 0 || id_len > MAX_ID_BYTES {
        anyhow::bail!("bad approval id length");
    }
    let mut id = vec![0u8; id_len];
    r.read_exact(&mut id)?;
    let id = String::from_utf8(id).map_err(|_| anyhow!("approval id is not UTF-8"))?;
    let pczt_len = read_u32(r)? as usize;
    if pczt_len == 0 || pczt_len > MAX_PCZT_BYTES {
        anyhow::bail!("bad proposal length");
    }
    let mut pczt = vec![0u8; pczt_len];
    r.read_exact(&mut pczt)?;
    Ok((id, pczt))
}

fn write_response<W: Write>(
    w: &mut W,
    ok: bool,
    code: &str,
    message: &str,
    artifact: &[u8],
) -> io::Result<()> {
    if code.len() > MAX_MESSAGE_BYTES || message.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "response too large"));
    }
    w.write_all(&RESP_MAGIC)?;
    w.write_all(&[IPV_VERSION])?;
    w.write_all(&[u8::from(ok)])?;
    w.write_all(&(code.len() as u16).to_le_bytes())?;
    w.write_all(code.as_bytes())?;
    w.write_all(&(message.len() as u16).to_le_bytes())?;
    w.write_all(message.as_bytes())?;
    w.write_all(&(artifact.len() as u32).to_le_bytes())?;
    w.write_all(artifact)?;
    w.flush()
}

fn read_response<R: Read>(r: &mut R) -> Result<(bool, String, String, Vec<u8>), anyhow::Error> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if magic != RESP_MAGIC {
        anyhow::bail!("bad response magic");
    }
    let mut version = [0u8; 1];
    r.read_exact(&mut version)?;
    if version[0] != IPV_VERSION {
        anyhow::bail!("unsupported protocol version");
    }
    let mut status = [0u8; 1];
    r.read_exact(&mut status)?;
    let code = read_string(r)?;
    let message = read_string(r)?;
    let len = read_u32(r)? as usize;
    if len > MAX_PCZT_BYTES {
        anyhow::bail!("response artifact too large");
    }
    let mut artifact = vec![0u8; len];
    r.read_exact(&mut artifact)?;
    Ok((status[0] != 0, code, message, artifact))
}

fn read_u16<R: Read>(r: &mut R) -> io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}

fn read_u32<R: Read>(r: &mut R) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_string<R: Read>(r: &mut R) -> Result<String, anyhow::Error> {
    let len = read_u16(r)? as usize;
    if len > MAX_MESSAGE_BYTES {
        anyhow::bail!("string too large");
    }
    let mut b = vec![0u8; len];
    r.read_exact(&mut b)?;
    String::from_utf8(b).map_err(|_| anyhow!("string is not UTF-8"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn gate_err(reason: &'static str, stage: Stage, detail: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(GateError::new(reason, stage, detail))
}

/// Test-only injected crash points, gated behind the fixtures flag. Aborting
/// releases the advisory lock and leaves whatever state was already fsynced.
fn crash_point(name: &str) {
    if fixtures_enabled() && std::env::var("AIRLOCK_GATE_TEST_CRASH_AFTER").as_deref() == Ok(name) {
        eprintln!("CRASH_INJECT point={name}");
        std::process::abort();
    }
}

/// Best-effort chain tip via `wallet balance --json` (local wallet DB, no
/// server connection required). Callers must treat `None` as fatal.
pub(crate) fn tip_via_devtool(wallet: &Path) -> Option<u32> {
    let exe = std::env::current_exe().ok()?;
    let out = Proc::new(exe)
        .args(["wallet", "-w", wallet.to_str()?, "balance", "--json"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(h) = v.get("chain_tip_height").and_then(|x| x.as_u64()) {
                return Some(h as u32);
            }
        }
        if let Some(pos) = line.find("chain_tip_height") {
            let rest = &line[pos + "chain_tip_height".len()..];
            let rest = rest.trim_start_matches(|c: char| c == ':' || c == ' ' || c == '"');
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(h) = digits.parse::<u32>() {
                return Some(h);
            }
        }
    }
    None
}
