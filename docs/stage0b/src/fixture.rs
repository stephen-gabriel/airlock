//! Test-only PCZT fixture helpers. All commands require
//! `AIRLOCK_GATE_TEST_FIXTURES=1` and are never part of the untrusted interface.

use std::fs;

use anyhow::anyhow;
use clap::{Args, Subcommand};
use pczt::{Pczt, roles::{creator::Creator, redactor::Redactor}};

use super::approval::ApprovalStore;
use std::path::Path;

#[derive(Debug, Args)]
pub(crate) struct FixtureCmd {
    #[arg(long)]
    pub(crate) gate_home: Option<std::path::PathBuf>,
    #[arg(long)]
    pub(crate) wallet: Option<std::path::PathBuf>,
    #[command(subcommand)]
    command: FixtureSub,
}

#[derive(Debug, Subcommand)]
pub(crate) enum FixtureSub {
    /// Patch a declared output `value` in the serialized PCZT (breaks cmx binding).
    PatchOutputValue {
        input: std::path::PathBuf,
        output: std::path::PathBuf,
        value: u64,
        /// Occurrence index of the original amount bytes to patch (0 = first).
        #[arg(long, default_value_t = 0)]
        occurrence: usize,
        /// Original amount to search for (zatoshis).
        #[arg(long, default_value_t = 5_000_000)]
        orig: u64,
    },
    /// Redact required verification data (missing-data case).
    Redact {
        input: std::path::PathBuf,
        output: std::path::PathBuf,
        /// Comma list: recipient, value, rseed, rcv, alpha, witness, fvk
        #[arg(long, value_delimiter = ',')]
        clear: Vec<String>,
    },
    /// Replace `coin_type` in global fields via postcard mirror round-trip.
    PatchCoinType {
        input: std::path::PathBuf,
        output: std::path::PathBuf,
        coin_type: u32,
    },
    /// Write a minimal Ironwood shell PCZT with no spends (foreign/empty fixture).
    EmptyShell { output: std::path::PathBuf },
    /// Drop bytes to corrupt the encoding.
    Corrupt {
        input: std::path::PathBuf,
        output: std::path::PathBuf,
        #[arg(long, default_value_t = 8)]
        drop_at: usize,
    },
}

fn require_test_mode() -> Result<(), anyhow::Error> {
    if std::env::var("AIRLOCK_GATE_TEST_FIXTURES").as_deref() != Ok("1") {
        anyhow::bail!("fixture commands require AIRLOCK_GATE_TEST_FIXTURES=1");
    }
    Ok(())
}

fn leb128(mut n: u64) -> Vec<u8> {
    let mut out = vec![];
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}

pub(crate) fn run(
    cmd: FixtureCmd,
    _store: &ApprovalStore,
    wallet: Option<&Path>,
    _identity: Option<&Path>,
) -> Result<(), anyhow::Error> {
    require_test_mode()?;
    match cmd.command {
        FixtureSub::PatchOutputValue {
            input,
            output,
            value,
            occurrence,
            orig,
        } => {
            let bytes = fs::read(&input)?;
            let _ = Pczt::parse(&bytes)?;
            let needle = leb128(orig);
            let positions: Vec<usize> = bytes
                .windows(needle.len())
                .enumerate()
                .filter(|(_, w)| *w == needle.as_slice())
                .map(|(i, _)| i)
                .collect();
            if positions.is_empty() {
                anyhow::bail!("original value bytes not found");
            }
            if occurrence >= positions.len() {
                anyhow::bail!("occurrence {occurrence} out of range ({})", positions.len());
            }
            let pos = positions[occurrence];
            let new_leb = leb128(value);
            if new_leb.len() != needle.len() {
                anyhow::bail!(
                    "patched value encoding length {} != original {} (choose a value with the same varint length)",
                    new_leb.len(),
                    needle.len()
                );
            }
            let mut patched = bytes;
            patched[pos..pos + needle.len()].copy_from_slice(&new_leb);
            fs::write(&output, patched)?;
            println!("PATCHED_OUTPUT_VALUE value={value} pos={pos} occ={occurrence}");
            Ok(())
        }
        FixtureSub::Redact {
            input,
            output,
            clear,
        } => {
            const KNOWN: [&str; 7] = [
                "recipient",
                "value",
                "rseed",
                "rcv",
                "alpha",
                "witness",
                "fvk",
            ];
            for c in &clear {
                if !KNOWN.contains(&c.as_str()) {
                    anyhow::bail!("unknown redact target: {c}");
                }
            }
            let pczt = Pczt::parse(&fs::read(&input)?)?;
            let mut r = Redactor::new(pczt);
            for c in &clear {
                r = r.redact_ironwood_with(|mut bundle_red| {
                    bundle_red.redact_actions(|mut act| {
                        match c.as_str() {
                            "recipient" => {
                                act.clear_spend_recipient();
                                act.clear_output_recipient();
                            }
                            "value" => {
                                act.clear_spend_value();
                                act.clear_output_value();
                            }
                            "rseed" => {
                                act.clear_spend_rseed();
                                act.clear_output_rseed();
                            }
                            "rcv" => act.clear_rcv(),
                            "alpha" => act.clear_spend_alpha(),
                            "witness" => act.clear_spend_witness(),
                            "fvk" => act.clear_spend_fvk(),
                            _ => unreachable!("validated above"),
                        }
                    });
                });
            }
            let redacted = r.finish();
            let bytes = redacted
                .serialize()
                .map_err(|e| anyhow!("serialize: {e:?}"))?;
            fs::write(&output, bytes)?;
            println!("REDACTED clear={clear:?}");
            Ok(())
        }
        FixtureSub::PatchCoinType {
            input,
            output,
            coin_type,
        } => {
            let g = fs::read(&input)?;
            #[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq)]
            struct GlobalMirror {
                tx_version: u32,
                version_group_id: u32,
                consensus_branch_id: u32,
                fallback_lock_time: Option<u32>,
                expiry_height: u32,
                coin_type: u32,
                tx_modifiable: u8,
                proprietary: std::collections::BTreeMap<String, Vec<u8>>,
            }
            let mut patched = None;
            for off in 0..64.min(g.len()) {
                let Ok(mirror) = postcard::from_bytes::<GlobalMirror>(&g[off..]) else {
                    continue;
                };
                if mirror.consensus_branch_id != 0x7719_0ad9 {
                    continue;
                }
                let Ok(orig_enc) = postcard::to_extend(&mirror, vec![]) else {
                    continue;
                };
                if g[off..].get(..orig_enc.len()) != Some(orig_enc.as_slice()) {
                    continue;
                }
                let mut new_mirror = mirror.clone();
                new_mirror.coin_type = coin_type;
                let Ok(new_enc) = postcard::to_extend(&new_mirror, vec![]) else {
                    continue;
                };
                if new_enc.len() != orig_enc.len() {
                    continue;
                }
                let mut out = g[..off].to_vec();
                out.extend_from_slice(&new_enc);
                out.extend_from_slice(&g[off + orig_enc.len()..]);
                patched = Some(out);
                break;
            }
            let patched = patched.ok_or_else(|| anyhow!("Global mirror not found"))?;
            // Sanity: still parses.
            let _ = Pczt::parse(&patched)?;
            fs::write(&output, patched)?;
            println!("PATCHED_COIN_TYPE -> {coin_type}");
            Ok(())
        }
        FixtureSub::EmptyShell { output } => {
            // Expiry must look plausible relative to the current tip so the
            // fixture fails on the intended check (no signable spend), not on
            // the expiry check. Margin of ~100 blocks stays within the
            // plausibility window (tip..tip+10000).
            let tip = wallet
                .and_then(super::tip_via_devtool)
                .unwrap_or(4_520_000);
            let expiry = tip.saturating_add(100).max(tip + 1);
            let pczt = Creator::new(0x7719_0ad9, expiry, 1, None, None)
                .map_err(|e| anyhow!("creator: {e:?}"))?
                .build()
                .map_err(|e| anyhow!("build: {e:?}"))?;
            let bytes = pczt
                .serialize()
                .map_err(|e| anyhow!("serialize: {e:?}"))?;
            fs::write(&output, bytes)?;
            println!("EMPTY_SHELL written expiry={expiry}");
            Ok(())
        }
        FixtureSub::Corrupt {
            input,
            output,
            drop_at,
        } => {
            let bytes = fs::read(&input)?;
            if bytes.len() <= drop_at + 8 {
                anyhow::bail!("corrupt: input too short");
            }
            let mut out = bytes[..drop_at].to_vec();
            out.extend_from_slice(&bytes[drop_at + 8..]);
            fs::write(&output, out)?;
            println!("CORRUPTED dropped 8 bytes at {drop_at}");
            Ok(())
        }
    }
}
