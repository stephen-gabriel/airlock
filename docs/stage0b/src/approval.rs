//! Approval records and the HMAC-authenticated, atomic approval store.
//!
//! Approvals are created only by the trusted operator (`approve`). The untrusted
//! proposer reaches signing only through a Unix-socket request that carries an
//! approval ID and proposal bytes; it has no code path to create, edit, or
//! abandon approvals and never receives wallet or identity configuration.
//!
//! Store invariants:
//! - one record per approval, written atomically (record + MAC in one file,
//!   temp file + fsync + rename within the protected directory);
//! - every transition (create / reserve / complete / abandon) is serialized by
//!   an advisory per-approval lock (`File::try_lock`);
//! - a bound transaction id is never cleared, and an abandoned or completed
//!   approval can never authorize a different transaction;
//! - any unreadable, malformed, or MAC-invalid state fails closed.

use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use sha2::Sha256;
use zcash_protocol::memo::{Memo, MemoBytes};

use super::validate::{GateError, Stage};

type HmacSha256 = Hmac<Sha256>;

pub const REASON_NO_APPROVAL: &str = "E_AUTH_NO_APPROVAL";
pub const REASON_TAMPERED: &str = "E_AUTH_TAMPERED";
pub const REASON_CONSUMED: &str = "E_AUTH_CONSUMED";
pub const REASON_IN_USE: &str = "E_AUTH_IN_USE";
pub const REASON_EXISTS: &str = "E_AUTH_EXISTS";
pub const REASON_ARTIFACT_EXISTS: &str = "E_AUTH_ARTIFACT_EXISTS";
pub const REASON_STATE_CORRUPT: &str = "E_STATE_CORRUPT";
pub const REASON_PATH_UNSAFE: &str = "E_PATH_UNSAFE";
pub const REASON_MEMO_UNSUPPORTED: &str = "E_MEMO_UNSUPPORTED";

const MAX_ID_LEN: usize = 64;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoPolicy {
    /// Exact UTF-8 memo text. Comparison is against the canonical 512-byte
    /// ZIP 302 encoding produced by the pinned `MemoBytes` implementation,
    /// byte for byte; there is no NUL truncation or prefix stripping.
    Exact(String),
    /// The library's canonical empty memo (`MemoBytes::empty()`: 0xf6 + zeros).
    Empty,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Approval {
    pub id: String,
    pub network: String,
    pub recipient_ua: String,
    pub amount_zatoshis: u64,
    pub max_fee_zatoshis: u64,
    pub memo_policy: MemoPolicy,
    /// Hex of the canonical 512-byte memo encoding. Written at creation and
    /// covered by the MAC; a record whose hex disagrees with its policy is
    /// treated as tampered. Absent legacy records omit it from their MAC input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo_canonical_hex: Option<String>,
    /// Unix seconds after which this approval may no longer authorize a new payment.
    pub expires_at_unix: u64,
    /// Single-payment authorization semantics: once a txid is bound, only that txid
    /// may complete under this approval.
    pub single_payment: bool,
    /// Set when the approval has been bound to a transaction (reserved or completed).
    /// Never cleared once set.
    pub bound_txid: Option<String>,
    /// Status of consumption.
    pub status: ApprovalStatus,
    /// File name (relative to `signed/`) of the signed PCZT for idempotent retry.
    pub signed_artifact: Option<String>,
    /// Unix seconds when the record was created / last updated.
    pub created_at_unix: u64,
    pub updated_at_unix: u64,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    /// Reserved for a specific txid; not available for a different payment.
    Reserved,
    Completed,
    /// Trusted recovery: abandoned by the operator (never by the requester).
    /// The bound txid, if any, is retained.
    Abandoned,
}

/// Canonical bytes covered by the MAC (everything except the MAC field itself).
#[derive(serde::Serialize)]
struct ApprovalEnvelope<'a> {
    #[serde(flatten)]
    approval: &'a Approval,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredRecord {
    version: u32,
    approval: Approval,
    mac: String,
}

pub struct ApprovalStore {
    root: PathBuf,
    mac_key: Vec<u8>,
}

/// Holds an exclusive per-approval advisory lock for the lifetime of the guard.
pub struct ApprovalLock {
    _file: File,
}

fn store_err(reason: &'static str, detail: impl Into<String>) -> GateError {
    GateError::new(reason, Stage::Authorization, detail)
}

fn io_err(what: &str, e: std::io::Error) -> GateError {
    // Deliberately excludes the path so proposer-visible errors never leak
    // operator filesystem layout.
    store_err(REASON_STATE_CORRUPT, format!("{what}: {}", e.kind()))
}

/// Approval IDs are operator-chosen capabilities; constrain them to a bounded
/// allowlist so they can never escape the approvals directory.
pub fn validate_id(id: &str) -> Result<(), GateError> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(store_err(
            REASON_PATH_UNSAFE,
            format!("approval id must be 1..={MAX_ID_LEN} bytes"),
        ));
    }
    if id.starts_with('.') {
        return Err(store_err(
            REASON_PATH_UNSAFE,
            "approval id must not start with '.'",
        ));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(store_err(
            REASON_PATH_UNSAFE,
            "approval id allows only [A-Za-z0-9._-]",
        ));
    }
    if id.contains("..") {
        return Err(store_err(REASON_PATH_UNSAFE, "approval id must not contain '..'"));
    }
    Ok(())
}

pub fn is_txid_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Canonical ZIP 302 encoding for an approved text memo.
///
/// Rejects text the pinned encoder cannot represent faithfully:
/// - empty text (use the `empty` policy; `Memo::from_str("")` means "no memo");
/// - embedded NUL bytes (ZIP 302 text memos must not contain 0x00, and NUL
///   truncation in any consumer would hide bytes);
/// - text longer than 512 bytes.
pub fn canonical_text_memo(text: &str) -> Result<[u8; 512], GateError> {
    if text.is_empty() {
        return Err(store_err(
            REASON_MEMO_UNSUPPORTED,
            "empty text memo is not supported; use the `empty` memo policy",
        ));
    }
    if text.as_bytes().contains(&0) {
        return Err(store_err(
            REASON_MEMO_UNSUPPORTED,
            "text memo must not contain NUL bytes",
        ));
    }
    if text.len() > 512 {
        return Err(store_err(
            REASON_MEMO_UNSUPPORTED,
            format!("text memo is {} bytes; maximum is 512", text.len()),
        ));
    }
    let memo = Memo::from_str(text)
        .map_err(|e| store_err(REASON_MEMO_UNSUPPORTED, format!("unsupported memo: {e}")))?;
    if matches!(memo, Memo::Empty) {
        return Err(store_err(
            REASON_MEMO_UNSUPPORTED,
            "empty text memo is not supported; use the `empty` memo policy",
        ));
    }
    Ok(*MemoBytes::from(memo).as_array())
}

pub fn canonical_empty_memo() -> [u8; 512] {
    *MemoBytes::empty().as_array()
}

impl Approval {
    /// Expected decrypted memo bytes for this approval, exactly.
    pub fn canonical_memo(&self) -> Result<[u8; 512], GateError> {
        let expected = match &self.memo_policy {
            MemoPolicy::Exact(text) => canonical_text_memo(text)?,
            MemoPolicy::Empty => canonical_empty_memo(),
        };
        if let Some(hexed) = &self.memo_canonical_hex {
            let mut stored = [0u8; 512];
            hex::decode_to_slice(hexed, &mut stored).map_err(|_| {
                store_err(REASON_TAMPERED, "approval memo canonical encoding malformed")
            })?;
            if stored != expected {
                return Err(store_err(
                    REASON_TAMPERED,
                    "approval memo canonical encoding disagrees with memo policy",
                ));
            }
        }
        Ok(expected)
    }
}

impl ApprovalStore {
    pub fn open(gate_home: &Path) -> Result<Self, GateError> {
        let root = gate_home.to_path_buf();
        ensure_dir(&root)?;
        for name in ["approvals", "reservations", "signed", "locks"] {
            ensure_dir(&root.join(name))?;
        }
        let key_path = root.join("mac.key");
        let mac_key = match fs::symlink_metadata(&key_path) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    return Err(store_err(REASON_PATH_UNSAFE, "mac.key must not be a symlink"));
                }
                if !md.file_type().is_file() {
                    return Err(store_err(REASON_STATE_CORRUPT, "mac.key is not a regular file"));
                }
                set_mode(&key_path, 0o600)?;
                fs::read(&key_path).map_err(|e| io_err("read mac.key", e))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut key = vec![0u8; 32];
                getrandom_fill(&mut key)?;
                write_new(&key_path, &key)?;
                set_mode(&key_path, 0o600)?;
                sync_dir(&root)?;
                key
            }
            Err(e) => return Err(io_err("stat mac.key", e)),
        };
        if mac_key.len() != 32 {
            return Err(store_err(REASON_STATE_CORRUPT, "mac.key must be 32 bytes"));
        }
        Ok(Self { root, mac_key })
    }

    fn mac(&self, approval: &Approval) -> Result<Vec<u8>, GateError> {
        let mut mac = HmacSha256::new_from_slice(&self.mac_key)
            .map_err(|_| store_err(REASON_STATE_CORRUPT, "HMAC init failed"))?;
        let body = serde_json::to_vec(&ApprovalEnvelope { approval })
            .map_err(|e| store_err(REASON_STATE_CORRUPT, format!("encode approval: {e}")))?;
        mac.update(&body);
        Ok(mac.finalize().into_bytes().to_vec())
    }

    fn record_path(&self, id: &str) -> PathBuf {
        self.root.join("approvals").join(format!("{id}.rec"))
    }

    fn legacy_paths(&self, id: &str) -> (PathBuf, PathBuf) {
        (
            self.root.join("approvals").join(format!("{id}.json")),
            self.root.join("approvals").join(format!("{id}.mac")),
        )
    }

    fn lock_path(&self, id: &str) -> PathBuf {
        self.root.join("locks").join(format!("{id}.lock"))
    }

    pub fn reservation_path(&self, id: &str) -> PathBuf {
        self.root.join("reservations").join(format!("{id}.json"))
    }

    pub fn signed_dir(&self) -> PathBuf {
        self.root.join("signed")
    }

    pub fn artifact_name(txid: &str) -> String {
        format!("{txid}.pczt")
    }

    pub fn audit_log_path(&self) -> PathBuf {
        self.root.join("audit.log")
    }

    pub fn append_audit(&self, line: &str) {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.audit_log_path())
        {
            let _ = writeln!(f, "{line}");
            let _ = f.sync_data();
        }
    }

    /// Acquire the exclusive per-approval lock. Non-blocking: a concurrent
    /// operator/proposer action on the same approval fails with
    /// `E_AUTH_IN_USE` instead of interleaving transitions.
    pub fn lock(&self, id: &str) -> Result<ApprovalLock, GateError> {
        validate_id(id)?;
        let path = self.lock_path(id);
        if let Ok(md) = fs::symlink_metadata(&path) {
            if md.file_type().is_symlink() {
                return Err(store_err(REASON_PATH_UNSAFE, "lock path must not be a symlink"));
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| io_err("open approval lock", e))?;
        match file.try_lock() {
            Ok(()) => Ok(ApprovalLock { _file: file }),
            Err(TryLockError::WouldBlock) => Err(store_err(
                REASON_IN_USE,
                "approval is busy with another operation",
            )),
            Err(TryLockError::Error(e)) => Err(io_err("lock approval", e)),
        }
    }

    pub fn create(&self, mut approval: Approval) -> Result<Approval, GateError> {
        validate_id(&approval.id)?;
        // Fail closed on unsupported memo text before any record is written.
        approval.canonical_memo()?;
        approval.created_at_unix = now_unix();
        approval.updated_at_unix = approval.created_at_unix;
        approval.status = ApprovalStatus::Pending;
        approval.bound_txid = None;
        approval.signed_artifact = None;

        let (legacy_json, legacy_mac) = self.legacy_paths(&approval.id);
        if legacy_json.exists() || legacy_mac.exists() {
            return Err(store_err(
                REASON_EXISTS,
                format!("approval id already exists: {}", approval.id),
            ));
        }
        let bytes = self.encode_record(&approval)?;
        let dir = self.root.join("approvals");
        let tmp = dir.join(unique_tmp_name(".create"));
        write_new(&tmp, &bytes)?;
        let result = fs::hard_link(&tmp, self.record_path(&approval.id));
        let _ = fs::remove_file(&tmp);
        match result {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(store_err(
                    REASON_EXISTS,
                    format!("approval id already exists: {}", approval.id),
                ));
            }
            Err(e) => return Err(io_err("create approval record", e)),
        }
        sync_dir(&dir)?;
        Ok(approval)
    }

    fn encode_record(&self, approval: &Approval) -> Result<Vec<u8>, GateError> {
        let record = StoredRecord {
            version: RECORD_VERSION,
            approval: approval.clone(),
            mac: hex::encode(self.mac(approval)?),
        };
        serde_json::to_vec_pretty(&record)
            .map_err(|e| store_err(REASON_STATE_CORRUPT, format!("encode record: {e}")))
    }

    pub fn load(&self, id: &str) -> Result<(Approval, Vec<u8>), GateError> {
        validate_id(id)?;
        let path = self.record_path(id);
        match fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(store_err(REASON_PATH_UNSAFE, "approval record must not be a symlink"))
            }
            Ok(md) if md.len() > MAX_RECORD_BYTES => {
                return Err(store_err(REASON_STATE_CORRUPT, "approval record too large"))
            }
            Ok(_) => {
                let bytes = fs::read(&path).map_err(|e| io_err("read approval record", e))?;
                let rec: StoredRecord = serde_json::from_slice(&bytes)
                    .map_err(|_| store_err(REASON_STATE_CORRUPT, "approval record malformed"))?;
                if rec.version != RECORD_VERSION {
                    return Err(store_err(REASON_STATE_CORRUPT, "unsupported record version"));
                }
                if rec.approval.id != id {
                    return Err(store_err(
                        REASON_TAMPERED,
                        "approval record identity does not match requested id",
                    ));
                }
                let mac_bytes = hex::decode(&rec.mac)
                    .map_err(|_| store_err(REASON_STATE_CORRUPT, "approval MAC malformed"))?;
                self.verify_mac(&rec.approval, &mac_bytes)?;
                Ok((rec.approval, mac_bytes))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.load_legacy(id),
            Err(e) => Err(io_err("stat approval record", e)),
        }
    }

    /// Read-only compatibility with Stage 0B records (`<id>.json` + `<id>.mac`).
    fn load_legacy(&self, id: &str) -> Result<(Approval, Vec<u8>), GateError> {
        let (json_path, mac_path) = self.legacy_paths(id);
        if !json_path.exists() {
            return Err(store_err(REASON_NO_APPROVAL, format!("no approval with id {id}")));
        }
        if let Ok(md) = fs::symlink_metadata(&json_path) {
            if md.file_type().is_symlink() {
                return Err(store_err(REASON_PATH_UNSAFE, "approval record must not be a symlink"));
            }
        }
        let bytes = fs::read(&json_path).map_err(|e| io_err("read legacy record", e))?;
        let approval: Approval = serde_json::from_slice(&bytes)
            .map_err(|_| store_err(REASON_STATE_CORRUPT, "legacy approval record malformed"))?;
        if approval.id != id {
            return Err(store_err(
                REASON_TAMPERED,
                "approval record identity does not match requested id",
            ));
        }
        let mac_bytes = fs::read(&mac_path).map_err(|e| io_err("read legacy MAC", e))?;
        self.verify_mac(&approval, &mac_bytes)?;
        Ok((approval, mac_bytes))
    }

    fn verify_mac(&self, approval: &Approval, mac_bytes: &[u8]) -> Result<(), GateError> {
        let expected = self.mac(approval)?;
        if expected.as_slice() != mac_bytes {
            return Err(store_err(REASON_TAMPERED, "approval MAC mismatch"));
        }
        Ok(())
    }

    /// Persist an updated approval. Caller must hold the per-approval lock.
    /// The record (terms + MAC) is replaced atomically.
    pub fn store_locked(&self, approval: &Approval) -> Result<(), GateError> {
        validate_id(&approval.id)?;
        let mut updated = approval.clone();
        updated.updated_at_unix = now_unix();
        let bytes = self.encode_record(&updated)?;
        let dir = self.root.join("approvals");
        write_replace(&dir, &format!("{}.rec", updated.id), &bytes)?;
        sync_dir(&dir)
    }

    /// Reserve `id` for `txid`. Caller must hold the per-approval lock.
    /// The binding (status + txid + reservation) is persisted before the caller
    /// releases any signature material.
    pub fn try_reserve(&self, id: &str, txid: &str) -> Result<ReserveOutcome, GateError> {
        if !is_txid_hex(txid) {
            return Err(store_err(REASON_STATE_CORRUPT, "binding txid is not lowercase hex64"));
        }
        let (mut approval, _) = self.load(id)?;
        match approval.status {
            ApprovalStatus::Abandoned => {
                return Err(store_err(REASON_CONSUMED, "approval abandoned"))
            }
            ApprovalStatus::Completed | ApprovalStatus::Reserved => {
                if approval.bound_txid.as_deref() == Some(txid) {
                    return Ok(ReserveOutcome::SameTx);
                }
                return Err(store_err(
                    REASON_CONSUMED,
                    "approval already bound to another transaction",
                ));
            }
            ApprovalStatus::Pending => {}
        }
        if self.reservation_path(id).exists() {
            // A reservation without a Reserved record is ambiguous state.
            return Err(store_err(
                REASON_STATE_CORRUPT,
                "reservation exists while approval is pending",
            ));
        }
        let res = serde_json::json!({
            "approval_id": id,
            "txid": txid,
            "pid": std::process::id(),
            "at_unix": now_unix(),
        });
        let dir = self.root.join("reservations");
        write_replace(
            &dir,
            &format!("{id}.json"),
            serde_json::to_vec_pretty(&res)
                .map_err(|e| store_err(REASON_STATE_CORRUPT, format!("encode reservation: {e}")))?
                .as_slice(),
        )?;
        approval.status = ApprovalStatus::Reserved;
        approval.bound_txid = Some(txid.to_string());
        self.store_locked(&approval)?;
        Ok(ReserveOutcome::Acquired)
    }

    /// Mark a reserved approval completed. Caller must hold the lock and must
    /// have durably written the artifact first.
    pub fn mark_completed(
        &self,
        id: &str,
        txid: &str,
        artifact_name: &str,
    ) -> Result<(), GateError> {
        let (mut approval, _) = self.load(id)?;
        if approval.bound_txid.as_deref() != Some(txid) {
            return Err(store_err(REASON_CONSUMED, "completion txid mismatch"));
        }
        approval.status = ApprovalStatus::Completed;
        approval.signed_artifact = Some(artifact_name.to_string());
        self.store_locked(&approval)
    }

    /// Trusted recovery. Acquires the per-approval lock internally.
    /// - completed approvals cannot be abandoned;
    /// - a reserved/bound approval with a persisted artifact cannot be
    ///   abandoned unless `force`, because a signature may already exist;
    /// - `force` keeps the bound txid, so the approval still can never
    ///   authorize a different transaction.
    pub fn abandon(&self, id: &str, force: bool) -> Result<(), GateError> {
        let _lock = self.lock(id)?;
        let (mut approval, _) = self.load(id)?;
        if approval.status == ApprovalStatus::Completed {
            return Err(store_err(REASON_CONSUMED, "cannot abandon a completed approval"));
        }
        if let Some(txid) = approval.bound_txid.as_deref() {
            if self.artifact_exists(txid)? && !force {
                return Err(store_err(
                    REASON_ARTIFACT_EXISTS,
                    "a signed artifact exists for this approval; refusing to abandon (use --force, binding is retained)",
                ));
            }
        }
        approval.status = ApprovalStatus::Abandoned;
        self.store_locked(&approval)
    }

    pub fn artifact_exists(&self, txid: &str) -> Result<bool, GateError> {
        if !is_txid_hex(txid) {
            return Err(store_err(REASON_STATE_CORRUPT, "artifact txid malformed"));
        }
        let path = self.signed_dir().join(Self::artifact_name(txid));
        match fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_symlink() => Err(store_err(
                REASON_PATH_UNSAFE,
                "signed artifact path must not be a symlink",
            )),
            Ok(md) if md.file_type().is_file() => Ok(true),
            Ok(_) => Err(store_err(REASON_STATE_CORRUPT, "signed artifact is not a file")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io_err("stat artifact", e)),
        }
    }

    pub fn read_artifact(&self, txid: &str) -> Result<Vec<u8>, GateError> {
        let path = self.signed_dir().join(Self::artifact_name(txid));
        match fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(store_err(REASON_PATH_UNSAFE, "signed artifact must not be a symlink"))
            }
            Ok(md) if md.file_type().is_file() => {}
            Ok(_) => return Err(store_err(REASON_STATE_CORRUPT, "signed artifact is not a file")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(store_err(
                    REASON_STATE_CORRUPT,
                    "signed artifact missing for completed approval",
                ))
            }
            Err(e) => return Err(io_err("stat artifact", e)),
        }
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_ARTIFACT_BYTES {
            return Err(store_err(REASON_STATE_CORRUPT, "signed artifact too large"));
        }
        fs::read(&path).map_err(|e| io_err("read artifact", e))
    }

    /// Durably write the signed artifact inside `signed/` (mode 0600, atomic
    /// replace, symlink-refusing).
    pub fn write_artifact(&self, txid: &str, bytes: &[u8]) -> Result<(), GateError> {
        if !is_txid_hex(txid) {
            return Err(store_err(REASON_STATE_CORRUPT, "artifact txid malformed"));
        }
        let dir = self.signed_dir();
        write_replace(&dir, &Self::artifact_name(txid), bytes)?;
        sync_dir(&dir)
    }

    pub fn list(&self) -> Result<Vec<Approval>, GateError> {
        let dir = self.root.join("approvals");
        let mut ids = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| io_err("read approvals dir", e))? {
            let entry = entry.map_err(|e| io_err("read approvals entry", e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let id = if let Some(id) = name.strip_suffix(".rec") {
                id
            } else if let Some(id) = name.strip_suffix(".json") {
                id
            } else {
                continue;
            };
            if validate_id(id).is_ok() {
                ids.push(id.to_string());
            }
        }
        ids.sort();
        ids.dedup();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            // Fail closed: a corrupt record must be surfaced, not hidden.
            let (approval, _) = self.load(&id)?;
            out.push(approval);
        }
        Ok(out)
    }

    pub fn signed_path(&self, name: &str) -> PathBuf {
        self.signed_dir().join(name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReserveOutcome {
    Acquired,
    SameTx,
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ensure_dir(path: &Path) -> Result<(), GateError> {
    match fs::symlink_metadata(path) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err(store_err(REASON_PATH_UNSAFE, "gate directory must not be a symlink"))
        }
        Ok(md) if !md.file_type().is_dir() => {
            return Err(store_err(REASON_STATE_CORRUPT, "gate path is not a directory"))
        }
        Ok(_) => return set_mode(path, 0o700),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err("stat gate directory", e)),
    }
    fs::create_dir_all(path).map_err(|e| io_err("create gate directory", e))?;
    set_mode(path, 0o700)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), GateError> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| io_err("set permissions", e))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), GateError> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| io_err("create file", e))?;
    f.write_all(bytes).map_err(|e| io_err("write file", e))?;
    f.sync_all().map_err(|e| io_err("sync file", e))?;
    Ok(())
}

/// Atomic replace within `dir`: temp file (0600, O_EXCL), fsync, rename, fsync
/// dir. Refuses to follow a symlink at the target name.
fn write_replace(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), GateError> {
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return Err(store_err(REASON_PATH_UNSAFE, "unsafe file name"));
    }
    let target = dir.join(name);
    if let Ok(md) = fs::symlink_metadata(&target) {
        if md.file_type().is_symlink() {
            return Err(store_err(REASON_PATH_UNSAFE, "target path must not be a symlink"));
        }
    }
    let tmp = dir.join(unique_tmp_name(".tmp"));
    write_new(&tmp, bytes)?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err("rename file", e)
    })?;
    Ok(())
}

fn sync_dir(dir: &Path) -> Result<(), GateError> {
    File::open(dir)
        .map_err(|e| io_err("open dir", e))?
        .sync_all()
        .map_err(|e| io_err("sync dir", e))
}

fn unique_tmp_name(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        now_unix(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn getrandom_fill(buf: &mut [u8]) -> Result<(), GateError> {
    use std::io::Read;
    let mut f = File::open("/dev/urandom").map_err(|e| io_err("open urandom", e))?;
    f.read_exact(buf).map_err(|e| io_err("read urandom", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct LegacyApproval<'a> {
        id: &'a str,
        network: &'a str,
        recipient_ua: &'a str,
        amount_zatoshis: u64,
        max_fee_zatoshis: u64,
        memo_policy: &'a MemoPolicy,
        expires_at_unix: u64,
        single_payment: bool,
        bound_txid: &'a Option<String>,
        status: ApprovalStatus,
        signed_artifact: &'a Option<String>,
        created_at_unix: u64,
        updated_at_unix: u64,
    }

    #[test]
    fn legacy_record_without_memo_canonical_hex_verifies() {
        let root = std::env::temp_dir().join(unique_tmp_name("airlock-legacy-approval"));
        let approvals = root.join("approvals");
        fs::create_dir_all(&approvals).unwrap();
        let key = [0x42u8; 32];
        write_new(&root.join("mac.key"), &key).unwrap();

        let approval = Approval {
            id: "legacy-test".to_string(),
            network: "test".to_string(),
            recipient_ua: "utest1legacy".to_string(),
            amount_zatoshis: 100_000,
            max_fee_zatoshis: 10_000,
            memo_policy: MemoPolicy::Empty,
            memo_canonical_hex: None,
            expires_at_unix: 1_800_000_000,
            single_payment: true,
            bound_txid: None,
            status: ApprovalStatus::Pending,
            signed_artifact: None,
            created_at_unix: 1_700_000_000,
            updated_at_unix: 1_700_000_000,
        };
        let legacy = LegacyApproval {
            id: &approval.id,
            network: &approval.network,
            recipient_ua: &approval.recipient_ua,
            amount_zatoshis: approval.amount_zatoshis,
            max_fee_zatoshis: approval.max_fee_zatoshis,
            memo_policy: &approval.memo_policy,
            expires_at_unix: approval.expires_at_unix,
            single_payment: approval.single_payment,
            bound_txid: &approval.bound_txid,
            status: approval.status,
            signed_artifact: &approval.signed_artifact,
            created_at_unix: approval.created_at_unix,
            updated_at_unix: approval.updated_at_unix,
        };

        let body = serde_json::to_vec(&legacy).unwrap();
        let mut mac = HmacSha256::new_from_slice(&key).unwrap();
        mac.update(&body);
        fs::write(
            approvals.join("legacy-test.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(approvals.join("legacy-test.mac"), mac.finalize().into_bytes()).unwrap();

        let store = ApprovalStore::open(&root).unwrap();
        let listed = store.list().unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "legacy-test");
        assert!(listed[0].memo_canonical_hex.is_none());

        fs::remove_dir_all(&root).unwrap();
    }
}
