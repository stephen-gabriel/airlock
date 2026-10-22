//! PCZT validation and the protected sign path.
//!
//! Validation operates on the same in-memory `Pczt` object that is subsequently
//! signed; the proposal file is never re-opened after the initial read.

use anyhow::anyhow;
use orchard::{
    keys::{FullViewingKey, PreparedIncomingViewingKey, Scope, SpendingKey},
    pczt::VerifyError,
};
use pczt::{
    Pczt,
    roles::{
        signer::Signer,
        verifier::{OrchardError, Verifier},
    },
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use secrecy::ExposeSecret;
use zcash_address::ZcashAddress;
use zcash_keys::address::Address;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::{NetworkConstants, Parameters};
use zip32::{AccountId, fingerprint::SeedFingerprint};

use super::approval::{Approval, MemoPolicy, now_unix};

/// Nu7 consensus branch id (ZIP-259).
pub const NU7_BRANCH_ID: u32 = 0x7719_0ad9;
pub const TESTNET_COIN_TYPE: u32 = 1;
pub const V6_TX_VERSION: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Parse,
    Scope,
    Crypto,
    Policy,
    Authorization,
    Expiry,
    Signing,
    NoSpend,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Parse => "parse",
            Stage::Scope => "scope",
            Stage::Crypto => "crypto",
            Stage::Policy => "policy",
            Stage::Authorization => "authorization",
            Stage::Expiry => "expiry",
            Stage::Signing => "signing",
            Stage::NoSpend => "no_signable_spend",
        }
    }
}

#[derive(Debug)]
pub struct GateError {
    pub reason: &'static str,
    pub stage: Stage,
    pub detail: String,
}

impl GateError {
    pub fn new(reason: &'static str, stage: Stage, detail: impl Into<String>) -> Self {
        Self {
            reason,
            stage,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} [{}]: {}",
            self.reason,
            self.stage.as_str(),
            self.detail
        )
    }
}

impl std::error::Error for GateError {}

pub struct GateKeys {
    pub seed: secrecy::SecretVec<u8>,
    pub seed_fp: SeedFingerprint,
    pub usk: UnifiedSpendingKey,
    pub fvk: FullViewingKey,
    pub ivk_external: PreparedIncomingViewingKey,
    pub ivk_internal: PreparedIncomingViewingKey,
}

pub struct ValidatedTx {
    pub signable_spends: Vec<usize>,
    pub fee_zatoshis: u64,
    pub payment_index: Option<usize>,
    pub change_indices: Vec<usize>,
    pub expiry_height: u32,
}

fn crypto_err(e: VerifyError) -> GateError {
    GateError::new("E_CRYPTO_VERIFY", Stage::Crypto, format!("{e:?}"))
}

fn orchard_err(e: OrchardError<GateError>) -> GateError {
    match e {
        OrchardError::Custom(g) => g,
        OrchardError::Parse(p) => GateError::new("E_PARSE", Stage::Parse, format!("{p:?}")),
        OrchardError::UnsupportedConsensusBranchId => GateError::new(
            "E_UNSUPPORTED_NETWORK_CONTEXT",
            Stage::Scope,
            "unsupported consensus branch for ironwood parse",
        ),
        OrchardError::Verify(v) => crypto_err(v),
    }
}

/// Decode approval recipient UA to an orchard/Ironwood address.
pub fn ua_orchard_address(
    ua: &str,
    params: &impl Parameters,
) -> Result<orchard::Address, GateError> {
    let addr = ZcashAddress::try_from_encoded(ua)
        .map_err(|e| GateError::new("E_POLICY_RECIPIENT", Stage::Policy, format!("bad UA: {e}")))?;
    let unified: Address = addr
        .convert_if_network::<Address>(params.network_type())
        .map_err(|e| {
            GateError::new(
                "E_POLICY_NETWORK",
                Stage::Policy,
                format!("UA network mismatch: {e}"),
            )
        })?;
    match unified {
        Address::Unified(ua) => ua.orchard().copied().ok_or_else(|| {
            GateError::new(
                "E_POLICY_RECIPIENT",
                Stage::Policy,
                "UA has no orchard/ironwood receiver",
            )
        }),
        _ => Err(GateError::new(
            "E_POLICY_RECIPIENT",
            Stage::Policy,
            "address is not a unified address",
        )),
    }
}

/// Validate a parsed PCZT against an approval and wallet keys. Does not sign.
pub fn validate(
    pczt: &Pczt,
    approval: &Approval,
    keys: &GateKeys,
    params: &impl Parameters,
    chain_tip: u32,
) -> Result<ValidatedTx, GateError> {
    // --- Authorization: approval terms ---
    if approval.network != "test" {
        return Err(GateError::new(
            "E_AUTH_NETWORK",
            Stage::Authorization,
            "approval network must be test",
        ));
    }
    if now_unix() > approval.expires_at_unix {
        return Err(GateError::new(
            "E_AUTH_EXPIRED",
            Stage::Authorization,
            "approval expired",
        ));
    }

    // --- Scope ---
    let global = pczt.global();
    if *global.tx_version() != V6_TX_VERSION {
        return Err(GateError::new(
            "E_UNSUPPORTED_VERSION",
            Stage::Scope,
            format!("tx_version={} (want V6)", global.tx_version()),
        ));
    }
    if *global.consensus_branch_id() != NU7_BRANCH_ID {
        return Err(GateError::new(
            "E_UNSUPPORTED_NETWORK_CONTEXT",
            Stage::Scope,
            format!(
                "consensus_branch_id={:#x} (want Nu7)",
                global.consensus_branch_id()
            ),
        ));
    }
    if *global.coin_type() != TESTNET_COIN_TYPE {
        return Err(GateError::new(
            "E_UNSUPPORTED_NETWORK_CONTEXT",
            Stage::Scope,
            format!(
                "coin_type={} (want testnet {TESTNET_COIN_TYPE})",
                global.coin_type()
            ),
        ));
    }
    if !pczt.transparent().inputs().is_empty() || !pczt.transparent().outputs().is_empty() {
        return Err(GateError::new(
            "E_UNSUPPORTED_POOL",
            Stage::Scope,
            "transparent component present",
        ));
    }
    if !pczt.sapling().spends().is_empty() || !pczt.sapling().outputs().is_empty() {
        return Err(GateError::new(
            "E_UNSUPPORTED_POOL",
            Stage::Scope,
            "sapling component present",
        ));
    }
    if !pczt.orchard().actions().is_empty() {
        return Err(GateError::new(
            "E_UNSUPPORTED_POOL",
            Stage::Scope,
            "orchard (non-Ironwood) component present",
        ));
    }

    let expiry = *global.expiry_height();
    if expiry == 0 {
        return Err(GateError::new(
            "E_EXPIRY",
            Stage::Expiry,
            "expiry_height is zero",
        ));
    }
    if expiry <= chain_tip {
        return Err(GateError::new(
            "E_EXPIRY",
            Stage::Expiry,
            format!("expiry_height={expiry} <= tip={chain_tip}"),
        ));
    }
    // NU7 expiry window is ~20 blocks; reject implausible far-future expiries.
    if expiry > chain_tip.saturating_add(10_000) {
        return Err(GateError::new(
            "E_EXPIRY",
            Stage::Expiry,
            format!("expiry_height={expiry} implausibly far from tip={chain_tip}"),
        ));
    }

    let expected_recipient = ua_orchard_address(&approval.recipient_ua, params)?;
    if pczt.ironwood().actions().is_empty() {
        return Err(GateError::new(
            "E_NO_SIGNABLE_SPEND",
            Stage::NoSpend,
            "empty Ironwood bundle",
        ));
    }

    // --- Crypto + policy over the parsed (orchard-typed) bundle ---
    let mut signable_spends = Vec::new();
    let mut spend_sum: u64 = 0;
    let mut output_sum: u64 = 0;
    let mut payment_index: Option<usize> = None;
    let mut change_indices: Vec<usize> = Vec::new();
    let seed_fp = keys.seed_fp;
    let coin_hardened = zip32::ChildIndex::hardened(params.network_type().coin_type());
    // Shielded sighash, needed to verify pre-existing padding signatures.
    let sighash = {
        let probe = Signer::new(pczt.clone())
            .map_err(|e| GateError::new("E_SIGN_INIT", Stage::Signing, format!("{e:?}")))?;
        probe.shielded_sighash()
    };

    let _verified_pczt = Verifier::new(pczt.clone())
        .with_ironwood::<GateError, _>(|bundle| {
            bundle.verify_cross_address_restriction()?;

            for (index, action) in bundle.actions().iter().enumerate() {
                let spend = action.spend();
                let output = action.output();

                // Field-doc MUST: signers reject dummy_sk.
                if spend.dummy_sk().is_some() {
                    return Err(OrchardError::Custom(GateError::new(
                        "E_POLICY_DUMMY_SK",
                        Stage::Policy,
                        format!("action {index} contains dummy_sk"),
                    )));
                }

                // Ownership classification, using the same rule as upstream
                // `pczt sign`: a spend is ours only if its ZIP 32 derivation
                // matches our seed fingerprint and coin type. Non-matching
                // spends must be zero-value padding pre-signed at build time;
                // their signatures are verified below and never replaced.
                let ours = spend
                    .zip32_derivation()
                    .as_ref()
                    .and_then(|d| d.extract_account_index(&seed_fp, coin_hardened))
                    .is_some();
                if ours && spend.fvk().as_ref() != Some(&keys.fvk) {
                    return Err(OrchardError::Custom(GateError::new(
                        "E_KEY_MISMATCH",
                        Stage::Crypto,
                        format!("action {index} zip32 marks ours but PCZT fvk differs"),
                    )));
                }
                if std::env::var("AIRLOCK_GATE_DEBUG").is_ok() {
                    eprintln!(
                        "DEBUG action {index}: ours={ours} fvk_set={}",
                        spend.fvk().is_some()
                    );
                }

                action.verify_cv_net()?;
                spend.verify_nullifier(if ours { Some(&keys.fvk) } else { None })?;
                spend.verify_rk(if ours { Some(&keys.fvk) } else { None })?;
                output.verify_note_commitment(spend)?;

                let spend_val = spend
                    .value()
                    .as_ref()
                    .ok_or_else(|| {
                        OrchardError::Custom(GateError::new(
                            "E_MISSING_DATA",
                            Stage::Crypto,
                            format!("action {index} spend value missing"),
                        ))
                    })?
                    .inner();
                let output_val = output
                    .value()
                    .as_ref()
                    .ok_or_else(|| {
                        OrchardError::Custom(GateError::new(
                            "E_MISSING_DATA",
                            Stage::Crypto,
                            format!("action {index} output value missing"),
                        ))
                    })?
                    .inner();
                spend_sum = spend_sum.checked_add(spend_val).ok_or_else(|| {
                    OrchardError::Custom(GateError::new(
                        "E_FEE_OVERFLOW",
                        Stage::Crypto,
                        "spend value overflow",
                    ))
                })?;
                output_sum = output_sum.checked_add(output_val).ok_or_else(|| {
                    OrchardError::Custom(GateError::new(
                        "E_FEE_OVERFLOW",
                        Stage::Crypto,
                        "output value overflow",
                    ))
                })?;

                if ours {
                    signable_spends.push(index);
                } else {
                    // Not ours: only zero-value padding with a valid
                    // pre-existing spend-auth signature is acceptable.
                    if spend_val != 0 {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_FOREIGN_SPEND",
                            Stage::NoSpend,
                            format!("action {index} is a nonzero spend not owned by the gate wallet"),
                        )));
                    }
                    let sig = spend.spend_auth_sig().as_ref().ok_or_else(|| {
                        OrchardError::Custom(GateError::new(
                            "E_FOREIGN_SPEND",
                            Stage::NoSpend,
                            format!("action {index} is an unsigned foreign spend"),
                        ))
                    })?;
                    spend.rk().verify(&sighash, sig).map_err(|e| {
                        OrchardError::Custom(GateError::new(
                            "E_PRE_SIGNED_INVALID",
                            Stage::Crypto,
                            format!("action {index} pre-signed padding signature invalid: {e:?}"),
                        ))
                    })?;
                }

                if output_val == 0 {
                    return Err(OrchardError::Custom(GateError::new(
                        "E_POLICY_ZERO_OUTPUT",
                        Stage::Policy,
                        format!("action {index} has a zero-value output"),
                    )));
                }

                let out_addr = output.recipient().as_ref().cloned().ok_or_else(|| {
                    OrchardError::Custom(GateError::new(
                        "E_MISSING_DATA",
                        Stage::Crypto,
                        format!("action {index} output recipient missing"),
                    ))
                })?;

                // Determine if this output is our change (decryptable with our IVK)
                // before requiring OVK recovery: change outputs use internal_ovk=None
                // under OvkPolicy::Sender, so OVK recovery legitimately fails for them.
                // Change is sent to address_at(0, Scope::Internal), so try both scopes.
                let ivk_result = action
                    .decrypt_output_with_ivk(&keys.ivk_external, *bundle.bundle_version())
                    .or_else(|e| {
                        if std::env::var("AIRLOCK_GATE_DEBUG").is_ok() {
                            eprintln!("DEBUG action {index}: ivk_external err: {e:?}");
                        }
                        Err(e)
                    })
                    .and_then(|r| {
                        if r.is_some() {
                            Ok(r)
                        } else {
                            // Try internal scope (change uses Scope::Internal address).
                            action.decrypt_output_with_ivk(&keys.ivk_internal, *bundle.bundle_version())
                        }
                    });
                if std::env::var("AIRLOCK_GATE_DEBUG").is_ok() {
                    eprintln!(
                        "DEBUG action {index}: ivk_result={:?} out_addr={:?}",
                        ivk_result.as_ref().map(|r| r.is_some()),
                        out_addr
                    );
                }
                let is_ours = match &ivk_result {
                    Ok(Some(_)) => true,
                    Ok(None) => false,
                    Err(e) => {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_MISSING_DATA",
                            Stage::Crypto,
                            format!("action {index} ivk decrypt: {e:?}"),
                        )));
                    }
                };

                let (_note, _rec_addr, memo_bytes) = if is_ours {
                    // Change output: IVK-decryptable; OVK recovery is not
                    // required (internal_ovk is None under OvkPolicy::Sender).
                    let decrypted = ivk_result
                        .map_err(|e| {
                            OrchardError::Custom(GateError::new(
                                "E_MISSING_DATA",
                                Stage::Crypto,
                                format!("action {index} ivk decrypt: {e:?}"),
                            ))
                        })?
                        .expect("is_ours implies Some");
                    (decrypted.0, out_addr, decrypted.2)
                } else {
                    // External payment: require sender-side OVK recovery so the
                    // memo bytes and recipient are bound to the ciphertext.
                    let recovered = action
                        .recover_output_with_ovk(
                            &keys.fvk.to_ovk(Scope::External),
                            *bundle.bundle_version(),
                        )
                        .map_err(|e| {
                            OrchardError::Custom(GateError::new(
                                "E_MISSING_DATA",
                                Stage::Crypto,
                                format!("action {index} ovk recovery: {e:?}"),
                            ))
                        })?
                        .ok_or_else(|| {
                            OrchardError::Custom(GateError::new(
                                "E_CRYPTO_OVK_RECOVERY",
                                Stage::Crypto,
                                format!("action {index} not recoverable with our OVK"),
                            ))
                        })?;
                    let (note, rec_addr, memo_bytes) = recovered;
                    if rec_addr != out_addr {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_CRYPTO_RECIPIENT_MISMATCH",
                            Stage::Crypto,
                            format!("action {index} recovered recipient != declared"),
                        )));
                    }
                    (note, rec_addr, memo_bytes)
                };

                if is_ours {
                    change_indices.push(index);
                    if std::env::var("AIRLOCK_GATE_DEBUG").is_ok() {
                        eprintln!(
                            "DEBUG action {index}: change memo first 16 bytes={:02x?}",
                            &memo_bytes[..16]
                        );
                    }
                    if !memo_is_empty(&memo_bytes) {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_POLICY_MEMO",
                            Stage::Policy,
                            format!("action {index} change output memo not empty"),
                        )));
                    }
                } else {
                    if payment_index.is_some() {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_POLICY_EXTRA_OUTPUT",
                            Stage::Policy,
                            format!("action {index} is an extra non-change output"),
                        )));
                    }
                    if out_addr != expected_recipient {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_POLICY_RECIPIENT",
                            Stage::Policy,
                            format!("action {index} recipient does not match approval"),
                        )));
                    }
                    if output_val != approval.amount_zatoshis {
                        return Err(OrchardError::Custom(GateError::new(
                            "E_POLICY_AMOUNT",
                            Stage::Policy,
                            format!(
                                "action {index} amount {output_val} != approved {}",
                                approval.amount_zatoshis
                            ),
                        )));
                    }
                    match &approval.memo_policy {
                        MemoPolicy::Exact(_) | MemoPolicy::Empty => {
                            // Exact comparison against the canonical 512-byte
                            // ZIP 302 encoding. No NUL truncation, no prefix
                            // stripping, no "looks like text" heuristics.
                            let expected = approval
                                .canonical_memo()
                                .map_err(OrchardError::Custom)?;
                            if memo_bytes != expected {
                                return Err(OrchardError::Custom(GateError::new(
                                    "E_POLICY_MEMO",
                                    Stage::Policy,
                                    format!(
                                        "action {index} memo bytes != approved memo bytes"
                                    ),
                                )));
                            }
                        }
                    }
                    payment_index = Some(index);
                }
            }
            Ok(())
        })
        .map_err(orchard_err)?;

    if payment_index.is_none() {
        return Err(GateError::new(
            "E_POLICY_NO_PAYMENT",
            Stage::Policy,
            "no output matches the approved payment",
        ));
    }

    let fee = spend_sum.checked_sub(output_sum).ok_or_else(|| {
        GateError::new("E_FEE_UNDERFLOW", Stage::Crypto, "outputs exceed spends")
    })?;
    if fee > approval.max_fee_zatoshis {
        return Err(GateError::new(
            "E_POLICY_FEE",
            Stage::Policy,
            format!("fee {fee} > max_fee {}", approval.max_fee_zatoshis),
        ));
    }
    if signable_spends.is_empty() {
        return Err(GateError::new(
            "E_NO_SIGNABLE_SPEND",
            Stage::NoSpend,
            "no spends match wallet keys",
        ));
    }

    Ok(ValidatedTx {
        signable_spends,
        fee_zatoshis: fee,
        payment_index,
        change_indices,
        expiry_height: expiry,
    })
}

fn memo_is_empty(memo: &[u8; 512]) -> bool {
    // Change outputs only: all-zero, 0xff + zeros (PCZT placeholder), or
    // 0xf6 + zeros (ZIP 203 empty-binary memo produced by MemoBytes::empty()).
    memo.iter().all(|&b| b == 0)
        || (memo[0] == 0xff && memo[1..].iter().all(|&b| b == 0))
        || (memo[0] == 0xf6 && memo[1..].iter().all(|&b| b == 0))
}

/// Sign the validated (ours-only) spends on the same in-memory PCZT, then
/// verify every signature — ours and pre-signed padding — before returning.
pub fn sign_validated(
    pczt: Pczt,
    keys: &GateKeys,
    validated: &ValidatedTx,
) -> Result<(Pczt, Vec<usize>), GateError> {
    let sighash = {
        let probe = Signer::new(pczt.clone())
            .map_err(|e| GateError::new("E_SIGN_INIT", Stage::Signing, format!("{e:?}")))?;
        probe.shielded_sighash()
    };

    if std::env::var("AIRLOCK_GATE_DEBUG").is_ok() {
        let ask = orchard::keys::SpendAuthorizingKey::from(keys.usk.orchard());
        let ak_from_ask = orchard::keys::SpendValidatingKey::from(&ask);
        let ak_from_fvk = orchard::keys::SpendValidatingKey::from(keys.fvk.clone());
        eprintln!(
            "DEBUG sign: ak_from_ask={:?} ak_from_fvk={:?} match={}",
            ak_from_ask, ak_from_fvk, ak_from_ask == ak_from_fvk
        );
        // Debug access to pczt internals skipped (private field); ak match
        // debug above confirms key consistency.
    }

    let mut signer = Signer::new(pczt)
        .map_err(|e| GateError::new("E_SIGN_INIT", Stage::Signing, format!("{e:?}")))?;
    let ask = orchard::keys::SpendAuthorizingKey::from(keys.usk.orchard());
    for &index in &validated.signable_spends {
        signer
            .sign_ironwood(UnwrapErr(SysRng), index, &ask)
            .map_err(|e| {
                GateError::new("E_SIGN_FAILED", Stage::Signing, format!("spend {index}: {e:?}"))
            })?;
    }
    let signed = signer.finish();

    // Cryptographically verify every produced signature by re-parsing the
    // signed bundle and checking redpallas against the shielded sighash.
    let mut verified = Vec::new();
    let _ = Verifier::new(signed.clone())
        .with_ironwood::<GateError, _>(|bundle| {
            // Every action must carry a valid spend-auth signature: the ones
            // we just produced plus any pre-signed padding we preserved.
            for index in 0..bundle.actions().len() {
                let action = bundle.actions().get(index).ok_or_else(|| {
                    OrchardError::Custom(GateError::new(
                        "E_NO_SIGNABLE_SPEND",
                        Stage::NoSpend,
                        "action missing after sign",
                    ))
                })?;
                let spend = action.spend();
                let sig = spend.spend_auth_sig().as_ref().ok_or_else(|| {
                    OrchardError::Custom(GateError::new(
                        "E_NO_SIGNATURE",
                        Stage::Signing,
                        format!("no spend_auth_sig on action {index}"),
                    ))
                })?;
                spend.rk().verify(&sighash, sig).map_err(|e| {
                    OrchardError::Custom(GateError::new(
                        "E_SIGNATURE_VERIFY",
                        Stage::Signing,
                        format!("action {index}: {e:?}"),
                    ))
                })?;
                verified.push(index);
            }
            Ok(())
        })
        .map_err(orchard_err)?;

    if verified.len() < validated.signable_spends.len() {
        return Err(GateError::new(
            "E_NO_SIGNABLE_SPEND",
            Stage::NoSpend,
            "signing produced no signatures",
        ));
    }
    Ok((signed, verified))
}

/// Load wallet keys the same way the devtool sign path does.
pub fn load_keys(
    wallet_dir: &std::path::Path,
    identity_path: &std::path::Path,
    params: &impl Parameters,
) -> Result<GateKeys, anyhow::Error> {
    let identities =
        age::IdentityFile::from_file(identity_path.to_string_lossy().into_owned())?.into_identities()?;
    let mut config = crate::config::WalletConfig::read(Some(wallet_dir))?;
    let seed = config
        .decrypt_seed(identities.iter().map(|i| i.as_ref() as _))?
        .ok_or_else(|| anyhow!("Seed must be present to enable signing"))?;
    let seed_fp = SeedFingerprint::from_seed(seed.expose_secret())
        .ok_or_else(|| anyhow!("Invalid seed length"))?;
    let usk = UnifiedSpendingKey::from_seed(params, seed.expose_secret(), AccountId::ZERO)?;
    let sk: &SpendingKey = usk.orchard();
    let fvk = FullViewingKey::from(sk);
    let ivk_external = fvk.to_ivk(Scope::External).prepare();
    let ivk_internal = fvk.to_ivk(Scope::Internal).prepare();
    Ok(GateKeys {
        seed,
        seed_fp,
        usk,
        fvk,
        ivk_external,
        ivk_internal,
    })
}
