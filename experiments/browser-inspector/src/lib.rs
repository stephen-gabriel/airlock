//! Disclosure checks, not proof, signature, ownership, or consensus verification.

use std::cell::RefCell;

use orchard::{Note, note::Rho, note_encryption::IronwoodDomain, pczt::VerifyError};
use pczt::{Pczt, orchard::EncCiphertext, roles::verifier::Verifier};
use serde_json::{Value, json};
use zcash_note_encryption::{Domain, try_output_recovery_with_pkd_esk};
use zcash_protocol::{
    consensus::BranchId,
    constants::{V6_TX_VERSION, V6_VERSION_GROUP_ID},
    value::Zatoshis,
};

/// This spike accepts at most 256 KiB and eight Ironwood actions.
pub const MAX_INPUT: usize = 256 * 1024;
const MAX_ACTIONS: usize = 8;

fn check(result: Result<(), VerifyError>, supplied: bool) -> Value {
    match result {
        Ok(()) => json!({
            "status": if supplied { "consistent" } else { "reconstructed" },
            "evidence": if supplied { "supplied commitment" } else { "derived from disclosures, no independent commitment" }
        }),
        Err(error) => json!({
            "status": if matches!(error,
                VerifyError::MissingFullViewingKey
                | VerifyError::MissingRandomSeed
                | VerifyError::MissingRecipient
                | VerifyError::MissingRho
                | VerifyError::MissingSpendAuthRandomizer
                | VerifyError::MissingValue
                | VerifyError::MissingValueCommitTrapdoor
            ) { "unavailable" } else { "inconsistent" },
            "reason": format!("{error:?}")
        }),
    }
}

/// Inspects a bounded PCZT using the pinned upstream parser and verification APIs.
/// Every successful check is relative to this input, not a chain or authorized txid.
pub fn inspect(bytes: &[u8]) -> Value {
    if bytes.len() > MAX_INPUT {
        return json!({"parsed": false, "error": "Input exceeds 256 KiB"});
    }
    let pczt = match Pczt::parse(bytes) {
        Ok(pczt) => pczt,
        Err(_) => return json!({"parsed": false, "error": "Upstream PCZT parser rejected input"}),
    };
    let global = pczt.global();
    let mut result = json!({
        "parsed": true,
        "transactionValidity": "NOT VERIFIED",
        "scope": "unsupported",
        "metadata": {
            "txVersion": global.tx_version(),
            "versionGroupId": format!("{:08x}", global.version_group_id()),
            "branchId": format!("{:08x}", global.consensus_branch_id()),
            "coinTypeClaim": global.coin_type(),
            "networkVerified": false,
            "expiryHeight": global.expiry_height(),
            "expiryFreshness": "unknown without trusted chain context",
            "txModifiable": global.tx_modifiable(),
            "ironwoodFlags": pczt.ironwood().flags(),
            "hasIronwoodProof": pczt.ironwood().zkproof().is_some()
        },
        "counts": {
            "transparentInputs": pczt.transparent().inputs().len(),
            "transparentOutputs": pczt.transparent().outputs().len(),
            "saplingSpends": pczt.sapling().spends().len(),
            "saplingOutputs": pczt.sapling().outputs().len(),
            "orchardActions": pczt.orchard().actions().len(),
            "ironwoodActions": pczt.ironwood().actions().len()
        },
        "notChecked": [
            "ZK proof and spend/binding signatures",
            "input existence, unspentness, anchor membership in chain",
            "wallet ownership, change ownership, operator authorization",
            "actual network or current expiry",
            "sender recovery out_ciphertext, payment completion"
        ]
    });
    if *global.tx_version() != V6_TX_VERSION
        || *global.version_group_id() != V6_VERSION_GROUP_ID
        || *global.consensus_branch_id() != u32::from(BranchId::Nu7)
        || !pczt.transparent().inputs().is_empty()
        || !pczt.transparent().outputs().is_empty()
        || !pczt.sapling().spends().is_empty()
        || !pczt.sapling().outputs().is_empty()
        || !pczt.orchard().actions().is_empty()
        || pczt.ironwood().actions().is_empty()
        || pczt.ironwood().actions().len() > MAX_ACTIONS
        || *pczt.sapling().value_sum() != 0
        || *pczt.orchard().value_sum() != (0, false)
    {
        result["reason"] =
            json!("Only NU7 V6 Ironwood-only proposals with 1..8 actions are checked");
        return result;
    }

    // Capture presence BEFORE upstream's typed parser resolves omitted v2 fields.
    let supplied = pczt.ironwood().clone();
    let mut actions = Vec::new();
    let mut total: Option<i128> = Some(0);
    let mut all_cv = true;
    let mut invalid_cv = false;
    let typed = Verifier::new(pczt.clone()).with_ironwood::<String, _>(|bundle| {
        result["crossAddressRestriction"] = if bundle.flags().cross_address_enabled() {
            json!({"status":"not_applicable","reason":"Bundle allows cross-address transfers"})
        } else {
            let mut restriction = check(bundle.verify_cross_address_restriction(), true);
            restriction["evidence"] = json!("Disclosed spend/output expanded receivers under supplied flags");
            restriction
        };
        for (index, action) in bundle.actions().iter().enumerate() {
            let wire = &supplied.actions()[index];
            let output = action.output();
            let spend = action.spend();
            let cv = check(action.verify_cv_net(), wire.cv_net().is_some());
            let commitment = check(output.verify_note_commitment(spend), wire.output().cmx().is_some());
            let values = spend.value().as_ref().zip(output.value().as_ref());
            let in_range = values.is_some_and(|(s, o)| {
                Zatoshis::from_u64(s.inner()).is_ok() && Zatoshis::from_u64(o.inner()).is_ok()
            });
            all_cv &= cv["status"] == "consistent" && in_range;
            invalid_cv |= cv["status"] == "inconsistent";
            total = total.zip(values).and_then(|(sum, (s, o))| {
                in_range.then_some(sum + i128::from(s.inner()) - i128::from(o.inner()))
            });
            let mut row = json!({
                "index": index,
                "recipientRaw": output.recipient().as_ref().map(|a| hex::encode(a.to_raw_address_bytes())),
                "amountZat": output.value().as_ref().map(|v| v.inner().to_string()),
                "userAddressClaim": wire.output().user_address(),
                "noteCommitment": commitment,
                "valueCommitment": cv,
                "valuesInRange": in_range,
                "nullifier": check(spend.verify_nullifier(None), true),
                "randomizedKey": check(spend.verify_rk(None), true),
                "memo": {"status": "unavailable", "reason": "Requires output recipient, value and rseed"},
                "hasSpendSignature": spend.spend_auth_sig().is_some()
            });
            if let (Some(recipient), Some(value), Some(rseed)) =
                (output.recipient(), output.value(), output.rseed())
            {
                if let Some(note) = Note::from_parts(
                    *recipient,
                    *value,
                    Rho::from_bytes(&spend.nullifier().to_bytes()).expect("parsed canonical nullifier"),
                    *rseed,
                    *output.note_version(),
                ).into_option() {
                    let domain = IronwoodDomain::for_pczt_action(action);
                    let recovery = IronwoodDomain::derive_esk(&note).and_then(|esk| {
                        try_output_recovery_with_pkd_esk(
                            &domain, IronwoodDomain::get_pk_d(&note), esk, action,
                        )
                    });
                    row["memo"] = match recovery {
                        Some((recovered_note, recovered_recipient, memo)) if recovered_recipient == *recipient
                            && recovered_note.value() == *value => {
                            let independent = matches!(wire.output().enc_ciphertext(), EncCiphertext::Encrypted(_));
                            json!({
                                "status": if independent { "consistent" } else { "reconstructed" },
                                "evidence": if !independent {
                                    "memo plaintext re-encrypted by upstream, no supplied ciphertext"
                                } else if wire.output().cmx().is_some() {
                                    "authenticated supplied note ciphertext against supplied cmx"
                                } else {
                                    "authenticated supplied note ciphertext against reconstructed cmx; no independent supplied cmx"
                                },
                                "cmxSource": if wire.output().cmx().is_some() { "supplied" } else { "reconstructed" },
                                "hex": hex::encode(memo)
                            })
                        },
                        _ => json!({"status": "inconsistent", "reason": "Ciphertext recovery failed"}),
                    };
                } else {
                    row["memo"] = json!({"status": "inconsistent", "reason": "Invalid disclosed output note"});
                }
            }
            actions.push(row);
        }
        Ok(())
    });
    match typed {
        Ok(_) => {
            result["scope"] = json!("supported");
            result["actions"] = json!(actions);
            let (magnitude, negative) = *supplied.value_sum();
            let declared = i128::from(magnitude) * if negative { -1 } else { 1 };
            let status = match total {
                Some(value)
                    if invalid_cv
                        || value != declared
                        || value < 0
                        || u64::try_from(value)
                            .ok()
                            .and_then(|v| Zatoshis::from_u64(v).ok())
                            .is_none() =>
                {
                    "inconsistent"
                }
                Some(_) if all_cv => "consistent",
                Some(_) => "unavailable",
                None => "unavailable",
            };
            result["fee"] = json!({
                "status": status,
                "declaredValueBalanceZat": declared.to_string(),
                "disclosedNetZat": total.map(|v| v.to_string()),
                "evidence": "sum of disclosed spends minus outputs, compared to bundle value balance and per-action cv_net; not a proof of valid inputs"
            });
        }
        Err(_) => {
            result["scope"] = json!("uncheckable");
            result["reason"] = json!(
                "Upstream typed Ironwood parser rejected fields or could not resolve omissions"
            );
        }
    }
    result
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

// Minimal byte-buffer ABI, no JS glue generator and no cryptographic code here.
// One worker owns one instance. Input bytes never leave that worker.
#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u8 {
    if len > MAX_INPUT {
        return std::ptr::null_mut();
    }
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn inspect_input() -> usize {
    let report = INPUT.with(|input| inspect(&input.borrow()));
    OUTPUT.with(|output| {
        *output.borrow_mut() = serde_json::to_vec(&report).expect("JSON report");
        output.borrow().len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output_buffer() -> *const u8 {
    OUTPUT.with(|output| output.borrow().as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_and_oversized_are_not_parsed() {
        assert_eq!(inspect(b"not a PCZT")["parsed"], false);
        assert_eq!(inspect(&vec![0; MAX_INPUT + 1])["parsed"], false);
    }

    #[test]
    fn missing_upstream_variants_are_unavailable_not_inconsistent() {
        for error in [
            VerifyError::MissingFullViewingKey,
            VerifyError::MissingRandomSeed,
            VerifyError::MissingRecipient,
            VerifyError::MissingRho,
            VerifyError::MissingSpendAuthRandomizer,
            VerifyError::MissingValue,
            VerifyError::MissingValueCommitTrapdoor,
        ] {
            assert_eq!(check(Err(error), true)["status"], "unavailable");
        }
        assert_eq!(
            check(Err(VerifyError::InvalidNullifier), true)["status"],
            "inconsistent"
        );
        assert_eq!(check(Ok(()), false)["status"], "reconstructed");
    }
}
