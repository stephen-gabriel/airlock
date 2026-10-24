//! Disposable synthetic partial PCZTs. No signatures, proofs, wallet or RPC.

use std::{fs, path::PathBuf};

use airlock_browser_inspector_spike::inspect;
use orchard::{
    Note,
    builder::{Builder, BundleType},
    bundle::{BundleVersion, Flags},
    keys::{FullViewingKey, Scope, SpendingKey},
    note::{NoteVersion, RandomSeed, Rho},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use pczt::{Pczt, roles::creator::Creator};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::{Value, json};
use zcash_primitives::transaction::{TxVersion, builder::PcztParts};
use zcash_protocol::consensus::{BlockHeight, BranchId, TEST_NETWORK};

// Public, disposable test-only seed. Never fund addresses derived from this seed.
const SYNTHETIC_SEED: [u8; 32] = [0x59; 32];
const SPEND_ZAT: u64 = 110_000;
const OUTPUT_ZAT: u64 = 100_000;
const EXPIRY: u32 = 4_600_000;

fn mutate(base: &Pczt, change: impl FnOnce(&mut Value)) -> Vec<u8> {
    // Use upstream serde + wire serializer, not an independent PCZT codec.
    let mut value = serde_json::to_value(pczt::v2::Pczt::try_from(base.clone()).unwrap()).unwrap();
    change(&mut value);
    serde_json::from_value::<pczt::v2::Pczt>(value)
        .unwrap()
        .serialize()
}

fn main() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/fixtures");
    fs::create_dir_all(&directory).unwrap();
    let sender = SpendingKey::from_bytes(SYNTHETIC_SEED).unwrap();
    let fvk = FullViewingKey::from(&sender);
    let recipient = fvk.address_at(1u32, Scope::External);
    let alternate = fvk.address_at(2u32, Scope::External);
    let rho = Rho::from_bytes(&[0; 32]).unwrap();
    let rseed = RandomSeed::from_bytes([0x34; 32], &rho).unwrap();
    let note = Note::from_parts(
        fvk.address_at(0u32, Scope::External),
        NoteValue::from_raw(SPEND_ZAT),
        rho,
        rseed,
        NoteVersion::V3,
    )
    .unwrap();
    // A coherent synthetic Merkle tree, NOT an anchor on any chain.
    let path = MerklePath::from_parts(0, [MerkleHashOrchard::from_bytes(&[0; 32]).unwrap(); 32]);
    let anchor = path.root(note.commitment().into());
    let version = BundleVersion::ironwood_v3();
    let mut builder = Builder::new(
        BundleType::UNPADDED,
        version,
        version.default_flags(),
        anchor,
    )
    .unwrap();
    builder.add_spend(fvk, note, path).unwrap();
    let mut memo = [0; 512];
    let message = b"SYNTHETIC inspector fixture, never broadcast";
    memo[..message.len()].copy_from_slice(message);
    builder
        .add_output(None, recipient, NoteValue::from_raw(OUTPUT_ZAT), memo)
        .unwrap();
    let (bundle, _) = builder
        .build_for_pczt(ChaCha20Rng::from_seed([0x62; 32]))
        .unwrap();
    assert_eq!(bundle.actions().len(), 1);
    assert!(bundle.zkproof().is_none());
    assert!(bundle.actions()[0].spend().spend_auth_sig().is_none());
    assert!(bundle.actions()[0].spend().dummy_sk().is_none());
    let pczt = Creator::build_from_parts(PcztParts {
        params: TEST_NETWORK,
        version: TxVersion::V6,
        consensus_branch_id: BranchId::Nu7,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(EXPIRY),
        transparent: None,
        sapling: None,
        orchard: None,
        ironwood: Some(bundle),
    })
    .unwrap();
    let base = pczt.clone().serialize().unwrap();
    let report = inspect(&base);
    assert_eq!(report["scope"], "supported", "{report}");
    for field in [
        "noteCommitment",
        "valueCommitment",
        "nullifier",
        "randomizedKey",
        "memo",
    ] {
        assert_eq!(
            report["actions"][0][field]["status"], "consistent",
            "{field}: {report}"
        );
    }
    assert_eq!(report["fee"]["status"], "consistent", "{report}");
    assert_eq!(report["actions"][0]["hasSpendSignature"], false);

    let mut cases: Vec<(&str, &str, Vec<u8>)> = vec![
        (
            "unsigned-valid-partial",
            "upstream-built, disclosure-consistent unsigned partial; NOT a valid final transaction",
            base.clone(),
        ),
        (
            "altered-amount",
            "parser-valid but disclosure-inconsistent",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["value"] = json!(OUTPUT_ZAT + 1)
            }),
        ),
        (
            "altered-recipient",
            "parser-valid but disclosure-inconsistent",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["recipient"] =
                    json!(alternate.to_raw_address_bytes().to_vec())
            }),
        ),
        (
            "altered-ciphertext",
            "parser-valid but ciphertext authentication fails",
            mutate(&pczt, |v| {
                let byte =
                    &mut v["ironwood"]["actions"][0]["output"]["enc_ciphertext"]["Encrypted"][100];
                *byte = json!(byte.as_u64().unwrap() ^ 1);
            }),
        ),
        (
            "altered-fee",
            "parser-valid but value balance inconsistent",
            mutate(&pczt, |v| v["ironwood"]["value_sum"][0] = json!(10_001)),
        ),
        (
            "missing-rseed",
            "redacted partial; note and memo checks unavailable",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["rseed"] = Value::Null
            }),
        ),
        (
            "missing-value",
            "redacted partial; amount and fee checks unavailable",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["value"] = Value::Null
            }),
        ),
        (
            "missing-fvk",
            "redacted partial; external ownership still unknown; nullifier and rk unavailable",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["spend"]["fvk"] = Value::Null
            }),
        ),
        (
            "missing-recipient",
            "redacted partial; receiver, note and memo unavailable",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["recipient"] = Value::Null
            }),
        ),
        (
            "missing-rcv",
            "redacted partial; per-action value commitment and conditional fee unavailable",
            mutate(&pczt, |v| v["ironwood"]["actions"][0]["rcv"] = Value::Null),
        ),
        (
            "altered-spend-rho",
            "parser-valid but nullifier disclosure inconsistent",
            mutate(&pczt, |v| {
                let mut rho = vec![0u8; 32];
                rho[0] = 1;
                v["ironwood"]["actions"][0]["spend"]["rho"] = json!(rho);
            }),
        ),
        (
            "altered-alpha",
            "parser-valid but randomized verification key inconsistent",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["spend"]["alpha"] = json!(vec![0u8; 32])
            }),
        ),
        (
            "compact-memo",
            "plaintext re-encrypted by upstream; not an independent supplied-ciphertext check",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["enc_ciphertext"] =
                    json!({"MemoPlaintext":message.to_vec()});
            }),
        ),
        (
            "missing-cross-address-evidence",
            "restricted bundle with missing spend receiver; output terms can match while coverage is unavailable",
            mutate(&pczt, |v| {
                v["ironwood"]["flags"] =
                    json!(Flags::CROSS_ADDRESS_DISABLED.to_byte(version).unwrap());
                v["ironwood"]["actions"][0]["spend"]["recipient"] = Value::Null;
            }),
        ),
        (
            "inconsistent-cross-address",
            "restricted bundle with different spend/output expanded receivers; not a valid transaction",
            mutate(&pczt, |v| {
                v["ironwood"]["flags"] =
                    json!(Flags::CROSS_ADDRESS_DISABLED.to_byte(version).unwrap());
            }),
        ),
        (
            "omitted-commitments",
            "derived commitments, NOT independently supplied commitments",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["cmx"] = Value::Null;
                v["ironwood"]["actions"][0]["cv_net"] = Value::Null;
            }),
        ),
        (
            "network-claim",
            "coin_type changed only; network is never cryptographically verified",
            mutate(&pczt, |v| v["global"]["coin_type"] = json!(133)),
        ),
        (
            "expiry-claim",
            "expiry changed; no current-chain freshness claim",
            mutate(&pczt, |v| v["global"]["expiry_height"] = json!(1)),
        ),
        (
            "hostile-label",
            "inert untrusted user_address; never a receiver authority",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["user_address"] =
                    json!("<img src=https://invalid.example/x onerror=globalThis.pwned=1>")
            }),
        ),
        (
            "unsupported-version",
            "parser-only metadata, not supported by this checker",
            mutate(&pczt, |v| v["global"]["tx_version"] = json!(5)),
        ),
        (
            "too-many-actions",
            "parser-only, action limit exceeded",
            mutate(&pczt, |v| {
                let action = v["ironwood"]["actions"][0].clone();
                v["ironwood"]["actions"] = json!(vec![action; 9]);
            }),
        ),
        (
            "bad-field-encoding",
            "wire parser may accept; typed cryptographic parser must reject",
            mutate(&pczt, |v| {
                v["ironwood"]["actions"][0]["output"]["cmx"] = json!(vec![255u8; 32])
            }),
        ),
    ];
    cases.push((
        "truncated",
        "malformed input",
        base[..base.len() / 2].to_vec(),
    ));
    cases.push(("bad-magic", "malformed input", b"not a PCZT".to_vec()));
    cases.push((
        "oversized",
        "must reject before parsing",
        vec![0; 256 * 1024 + 1],
    ));

    let mut manifest = Vec::new();
    for (name, class, bytes) in cases {
        let report = inspect(&bytes);
        fs::write(directory.join(format!("{name}.bin")), &bytes).unwrap();
        manifest.push(json!({"name":name,"class":class,"bytes":bytes.len(),"nativeReport":report}));
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let policy = json!({
        "coinTypeClaim": 1, "branchId": format!("{:08x}", u32::from(BranchId::Nu7)),
        "minExpiry": 4_500_000, "maxExpiry": EXPIRY, "maxFeeZat": "10000",
        "outputs": [{"recipientRaw": hex::encode(recipient.to_raw_address_bytes()), "amountZat": OUTPUT_ZAT.to_string(), "memoHex": hex::encode(memo)}]
    });
    fs::write(
        directory.join("policy.json"),
        serde_json::to_vec_pretty(&policy).unwrap(),
    )
    .unwrap();
    println!(
        "Generated {} disposable cases; no proof, signatures, wallet access or broadcast.",
        manifest.len()
    );
}
