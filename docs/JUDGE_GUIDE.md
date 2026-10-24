# Airlock Inspector: judge guide

**Current hackathon submission: https://airlock-inspector.pages.dev/**

The deployed product is a static, browser-local PCZT disclosure-consistency
inspector and intended-policy comparator. It does **not** sign, broadcast, connect
a wallet, establish funding or validate complete transactions.

## 1. Three-minute walkthrough

Wait for **Local checker ready**. Each sample is a public **synthetic unsigned
partial**, not a funded or chain-valid final transaction. Loading only fills the
proposal/policy; **Inspect locally** runs actual pinned upstream Rust in WASM.

1. **Matching terms:** choose **Load example**, review the intended policy, then
   **Inspect locally**. Output terms match and implemented supplied-field
   checks are consistent. This is not a valid/funded/authorized transaction verdict.
2. **Altered amount:** load and inspect. Expect **100,001 zat disclosed versus
   100,000 zat intended**, plus failed note/value commitment, ciphertext and
   balance consistency checks. A policy difference and a cryptographic disclosure
   inconsistency are separate findings.
3. **Missing disclosure:** load and inspect. Output terms can still match.
   The missing spend full viewing key (FVK) prevents nullifier and randomized-key
   checks, so overall disclosure evidence is **incomplete**, not verified.

Expand exact memo hex and coverage details if useful. Memo equality uses all
512 original bytes, not a text preview. **Clear** removes file selection, policy
and results. Editing any input clears stale results and cancels old inspections.
Never fund the synthetic addresses.

**Owner-reported physical-device check:** the owner manually tested all three
examples and Clear on a physical Android phone over mobile data. This is a manual
owner report, not independently recorded automation evidence or proof about chain
validity. Do not conflate it with the local Chrome emulation checks below.

## 2. Read the exact claim

Supported: pre-release **NU7, V6/version-group V6, Ironwood-only PCZTs**, **1–8 actions**
and **256 KiB maximum**. Other versions/pools and Unified Addresses are outside
the implemented scope. This pinned pre-release snapshot does not establish current
activation on a live network.

Inspector compares exact raw receivers, decimal zat strings, all ordered action
outputs (including dummy/zero outputs), exact 512-byte memos and a conditional fee.
No output is inferred to be change. It separately shows supplied-consistent,
reconstructed, unavailable and inconsistent disclosure evidence.

**Not checked:** ZK proofs, signatures, authorization, actual funding/unspentness,
wallet/change ownership, real-chain anchor membership, actual network, current
expiry, settlement or payment completion. Coin type/branch/expiry comparisons are
metadata/static bounds, not chain verification. The file's disclosed FVK is not
an independently trusted wallet identity. A fabricated/unfunded proposal can pass
the implemented checks.

Proposal and intended-policy bytes remain local. There is no API, signing,
broadcast, telemetry, account or external runtime asset. Static assets/selected
public examples are fetched; trust in the delivered page, WASM and browser remains
necessary. Clear is not a physical memory-erasure guarantee. Use synthetic data.

- [Root README](../README.md): submission, examples, deployment and licenses.
- [Inspector technical README](../experiments/browser-inspector/README.md):
  exact checks, resource boundaries, upstream pins and reproduction.
- [Original and third-party licensing](../THIRD_PARTY_NOTICES.md):
  our MIT work versus upstream code embedded in WASM.

## 3. Reproduce, without a wallet or demo inventory

Requirements: Rust/Cargo (tested 1.99.1), rustup/wasm32 target, a native C linker,
Node 24 and network access for locked dependencies. Chrome/Chromium is optional
for browser tests. No npm install, wallet, proving keys or testnet funds are needed.

From the repository root in Linux/WSL:

```sh
set -e
cd experiments/browser-inspector
rustup target add wasm32-unknown-unknown
cargo build --locked --release --lib --target wasm32-unknown-unknown
cargo run --locked --release --manifest-path fixtures/Cargo.toml --target-dir target/fixtures
node build.mjs
node --test inspector.test.mjs
# Optional, installed Chrome/Chromium; CHROME_PATH may be set:
# node browser-test.mjs
node serve.mjs --dist
```

Preview: `http://127.0.0.1:8089`. Both Cargo lock files and the upstream Git revision
are pinned. A cache-only machine can add `--offline`; a fresh machine must obtain
those dependencies. No private original Airlock state is consumed.

The prior local Chrome suite compared 25 native/WASM fixture reports and tested
desktop/390px layouts, stale-result cancellation, hostile text, input limits,
worker deadlines and WASM retry. The current 18 Node regressions test evidence,
memo, async boundaries and license packaging/serving. These are reported local results, not an independent
audit, physical-phone automation or validation of the deployed bytes.

## 4. Deployment is a separate owner action

Build output: **`experiments/browser-inspector/dist/`**, now **19 allowlisted files**
including `LICENSE.txt` and `THIRD_PARTY_LICENSES.txt`, versus the earlier 17-file
upload. Dist/WASM/generated examples and screenshots/test reports are ignored.

The existing Cloudflare Pages project uses **Direct Upload**, not Git integration.
**Pushing GitHub commits does not update https://airlock-inspector.pages.dev/.**
The owner must manually open **Workers & Pages → airlock-inspector → Create a new
deployment → Production**, upload the rebuilt dist folder (or zip contents with
`index.html` at root), retain `_headers`, and select **Save and Deploy**.
Only dist is publishable, never the repository or original wallet/API state.

See the [full owner upload checklist](../README.md#cloudflare-pages-direct-upload-owner-action-only)
and [Cloudflare Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/).
After upload, recheck all examples, Clear, WASM MIME/CSP and both notice URLs.
**No redeployment was performed in this documentation change. The notice-complete
19-file package still requires owner re-upload.**

## 5. Historical signing-gate prototype, not this demo

The preserved original Airlock prototype uses an API, proposer/worker, separately
confined Rust signing gate, operator approvals and private testnet state.
Its earlier matching payments were signed, broadcast and confirmed; changed
recipient/memo proposals were rejected. That evidence belongs **only to the
original prototype**, not to Inspector and not to the deployed URL.

- [Preserved original documentation](../README.md#preserved-original-signing-gate-prototype-historical-only)
- [Historical architecture](ARCHITECTURE.md) and [historical limitations](LIMITATIONS.md)
- [Sanitized historical testnet evidence](evidence/README.md)
- [Original pinned gate reproduction/licenses](upstream/zcash-devtool/README.md)
- [Optional original private-state gate tests](../tests/gate/README.md)

Those services need excluded wallets/identities, gate state and operator inventory.
They are not needed to review Inspector. Historical txids, signing-gate assertions
and fixture-only original UI checks must not be presented as Inspector's capabilities
or evidence of its complete-transaction validation.
