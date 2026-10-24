# Airlock Inspector

**Current hackathon submission: https://airlock-inspector.pages.dev/**

A browser-local lens for disclosed Zcash proposals. Load a PCZT, enter your intended
output policy, and run pinned upstream Rust disclosure-consistency checks in WASM.
Output-policy comparison and disclosure coverage answer separate questions:
do the disclosed terms agree with your intent, and what evidence could actually
be checked?

Inspector **does not sign, broadcast, connect a wallet, verify funding or validate
complete transactions**. It has no application API or telemetry. Proposal bytes and
entered policy stay in the browser; only static app assets and explicitly selected
public synthetic examples are fetched. Trust in the delivered page, WASM and browser
is still required. Use the supplied synthetic data rather than private wallet PCZTs.

## Try the three examples

Open the [deployed Inspector](https://airlock-inspector.pages.dev/). For each example,
choose **Load example**, review the intended policy, then **Inspect locally**.
Loading is not an inspection; results come from the actual WASM checker.

| Example | Expected outcome |
|---|---|
| Matching terms | Output terms match. Implemented supplied-field checks are consistent; no transaction-validity or funding conclusion. |
| Altered amount | Disclosed output is 100,001 zat versus intended 100,000. Policy values differ and commitment/ciphertext/balance disclosure checks fail. |
| Missing disclosure | Output terms can match, but absent spend FVK prevents nullifier and randomized-key checks. Overall disclosure evidence is incomplete, not verified. |

All three are **public synthetic unsigned partials**, not funded or chain-valid final
transactions. Never fund their addresses. **Clear** removes the selected proposal,
policy and results, without promising physical browser-memory erasure.

**Owner-reported manual check:** the owner tested all three examples and Clear on a
physical Android phone over mobile data. This is a manual owner report, not independent
automation evidence. Separately, local validation recorded 25 native/WASM fixture
comparisons and desktop/390px emulation checks in Chrome. The current 18 focused Node
regressions also cover license packaging and notice serving. These are not physical-device
or live-chain verification.

## Supported scope and limits

- Pre-release **NU7, V6/version-group V6, Ironwood-only PCZTs**, 1–8 actions, maximum
  256 KiB. Other pools/versions and Unified Addresses are outside the implemented scope.
- All action outputs are ordered, including dummy/zero outputs. Receivers use raw hex,
  amounts use exact decimal zat strings, and memo equality uses all **512 original bytes**,
  never a readable preview. No inferred change.
- Supplied-consistent, reconstructed, unavailable and inconsistent evidence remain
  distinct. Reconstruction/missing evidence is not verification; a disclosed FVK is
  not a trusted wallet identity.
- No proof/signature/authorization validation, input existence/unspentness, funding,
  wallet ownership, real-chain membership, actual network/current expiry, settlement
  or payment-completion claim. Coin type and expiry comparisons are metadata/static
  bounds only. Matching implemented checks can still describe a fabricated proposal.
- Pre-release and unaudited. Browser resource limits, short-lived isolated workers
  and stale-result cancellation are safeguards, not a completed security/fuzz audit.

Start with the [judge guide](docs/JUDGE_GUIDE.md) and the
[Inspector technical README](experiments/browser-inspector/README.md).

## Reproduce Inspector and its static package

Prerequisites not provided by Git: Rust/Cargo (tested 1.99.1, edition-2024 support),
rustup, a native C linker, Node 24, and initial network access for pinned Cargo
dependencies. No npm install, wallet, demo inventory, proving keys or API is needed.
Chrome/Chromium is needed only for the optional browser suite.

From the repository root in Linux/WSL:

```sh
set -e
cd experiments/browser-inspector
rustup target add wasm32-unknown-unknown
cargo build --locked --release --lib --target wasm32-unknown-unknown
cargo run --locked --release --manifest-path fixtures/Cargo.toml --target-dir target/fixtures
node build.mjs
node --test inspector.test.mjs
# Optional browser suite:
# node browser-test.mjs
# Static local preview:
node serve.mjs --dist
```

Preview: `http://127.0.0.1:8089`. On Windows, the Cargo steps may run in WSL and
`node .\experiments\browser-inspector\build.mjs` in repository-root PowerShell.
`--offline` works only after dependencies are cached; `--locked` preserves both lock files.

The build produces **`experiments/browser-inspector/dist/`**, now **19 allowlisted
files**, including `LICENSE.txt` and `THIRD_PARTY_LICENSES.txt`. The prior uploaded
package had 17 files. Dist, WASM, generated examples/fixtures, targets and test
reports/screenshots are ignored; Git alone does not provide the deployable binaries.
`deployment-manifest.json` records the locally prepared package's lengths and hashes.

## Cloudflare Pages Direct Upload, owner action only

The public URL is a **Direct Upload** deployment. **GitHub pushes do not automatically
update the deployed site.** There is no Git-connected deployment workflow here.

1. Build the package above and review its manifest. Upload only
   `experiments/browser-inspector/dist/`, not the repository, `web/`, wallets,
   test artifacts or the original signing-gate app.
2. In Cloudflare **Workers & Pages**, select the existing **airlock-inspector**
   Pages project, then **Create a new deployment** and choose **Production**.
3. Drag/drop the dist folder (or a zip of its contents). Confirm `index.html`,
   WASM, examples, both license/notice files and `_headers` are at the expected
   paths, not nested under an extra `dist/` directory.
4. Choose **Save and Deploy**. Preserve `_headers`, especially WASM MIME and worker
   CSP. Then recheck the public URL, all three examples, Clear and the notice URLs.

See Cloudflare's [Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/)
and [header rules](https://developers.cloudflare.com/pages/configuration/headers/).
No redeployment was performed for this documentation/license update. **The owner must
manually re-upload the new 19-file package to publish the required bundled notices.**
The existing site remains the previously uploaded version until that happens.

## Preserved original signing-gate prototype, historical only

The repository also preserves the original API/worker/confined signing-gate prototype,
its source and sanitized historical testnet evidence. **It is not the deployed Inspector.**
Its signed/broadcast/confirmed testnet transactions do not prove that Inspector signs,
broadcasts, verifies funding or validates complete transactions.

The expandable historical notes below describe that earlier prototype only, including
its private-state prerequisites and then-local-only deployment status. They are not
instructions for the current public demo.

<details>
<summary>Original signing-gate documentation and historical evidence</summary>

**Permission before signature.** Airlock is a policy gate for shielded Zcash testnet
payments. An operator approves an exact payment intent, an application proposes a
transaction, and a separately confined signer verifies the actual PCZT before releasing a
signature.

Airlock is not a wallet and does not custody funds. It is a reusable pattern for giving an
integration or automation a payment task without giving it signing keys.

## Status

- **Local testnet proof: complete.** A matching shielded payment was signed through the
  gate, broadcast, and confirmed. Genuine changed-recipient and changed-memo proposals were
  rejected by the gate.
- **Local API/UI: working.** Sessions, operator-provisioned approvals, job state, receipt
  detail/export, same-job resume, broadcast reconciliation, and truthful health are
  implemented.
- **Responsive/keyboard verification: partial.** Reachable states were checked at desktop,
  tablet, 390 px, 320 px, 200% zoom, with keyboard and reduced motion. Six missing live
  states have visibly marked, test-only fixture coverage. Unreachable states are listed in
  [LIMITATIONS.md](docs/LIMITATIONS.md).
- **Public deployment: not included.** No host, HTTPS endpoint, second-network test, or
  always-on judge URL is provided. Testnet only; mainnet is not supported or exercised.
- **Audit status: not audited.** This is a hackathon prototype, not production custody
  software.

## Quick start

Requires Node.js 24+ and npm. Run the API checks on Linux or WSL2 because the M2 suite uses
a Unix socket:

```bash
cd apps/api
npm ci
cd ../..
scripts/check.sh
```

The checks build and typecheck the API, syntax-check the browser/fixture files, and run the
five M2 API tests. They use a synthetic worker and consume no approval, inventory, or
testnet funds. For a fresh Codespace, gate build prerequisites, optional gate tests, and
live-state boundaries, see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

Optional fixture-only UI check (needs Chrome or Chromium):

```bash
node tests/m3-fixtures/run.mjs
```

Set `CHROME_PATH` if the browser is not standard. Output goes to the ignored
`tests/m3-fixtures/artifacts/` directory unless `AIRLOCK_FIXTURE_OUT` is set. Every fixture
page is marked `TEST FIXTURE - NOT LIVE`.

Optional gate regression and boundary tests under `tests/gate/` need a disposable funded
testnet wallet, identity, recipient UA, patched devtool, and namespace support. They do not
broadcast or use demo inventory. See [`tests/gate/README.md`](tests/gate/README.md).

## What is enforced

1. The operator creates a single-payment approval: recipient, amount, exact memo, maximum
   fee, and expiry. The public API cannot create or widen one.
2. A browser session can only select an approval already assigned to that session.
3. The worker builds the supported shielded testnet proposal and invokes the gate.
4. The gate validates the real PCZT and its independent approval record, then binds the
   approval to the transaction before signing.
5. A changed recipient, amount, fee, memo, expiry, network, or output layout is rejected
   with a specific reason and no signature.
6. Retry/resume reuses the original job and retained artifact. A broadcast-unknown outcome
   is reconciled against the original txid first; it is never rebuilt or re-signed.

The disposable demo sessions expose only an operator-funded testnet sandbox. No arbitrary
recipient, amount, memo, file upload, or approval creation is available from the browser.

## Architecture

```text
Browser (vanilla HTML/CSS/JS)
        |
        | same-origin HTTP, HttpOnly session cookie
        v
Public API / proposer (Node 24 + TypeScript)
        |
        | private Unix socket, fixed command arguments
        v
Worker (proposal builder, proving, wallet sync, broadcast)
        |
        | private Unix socket, ALG1/ALR1 submit
        v
Rust gate -> PCZT validation -> approval binding -> signature
        |
        v
Zcash testnet
```

The API has no wallet, gate-home, signing key, or approval MAC key. The worker can build and
broadcast but does not receive the gate home. The gate owns MAC-protected approvals and
signs only a validated, bound proposal. The local lifecycle scripts run each service under
`bubblewrap` with private sockets; the API binds to `127.0.0.1`.

Health is freshness-limited to 300 seconds, so a stale chain view is shown as degraded rather
than as success. `scripts/web/refresh-health.sh` performs a read-only worker sync; it does not
consume a job, approval, inventory set, or signature.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for components, trust boundaries, and API routes.

## Gate reproduction

The gate is a patched build of `zcash-devtool`:

- Upstream: `https://github.com/zcash/zcash-devtool.git`
- Pin: `0b3436bb8d235c67cd36b800cb45a7b1b489c415`
- Patch: [`docs/stage0b_changes.diff`](docs/stage0b_changes.diff)
- Tested binary SHA-256:
  `9a87f3daec59640011da655c53b6fbcc25ed0eb37631ac439a46efc1ea137f6a`

```bash
scripts/build-gate.sh
```

Or apply manually:

```bash
git clone https://github.com/zcash/zcash-devtool.git
git -C zcash-devtool checkout 0b3436bb8d235c67cd36b800cb45a7b1b489c415
git -C zcash-devtool apply ../docs/stage0b_changes.diff
cargo build --release --locked --manifest-path zcash-devtool/Cargo.toml
```

The patch includes the gate module and the `wallet/sync.rs` fix. The source snapshot under
`docs/stage0b/src/` is for review; the diff is authoritative. A rebuild can differ when the
Rust toolchain differs. See
[docs/upstream/zcash-devtool/README.md](docs/upstream/zcash-devtool/README.md).

## Running the prepared services

The live services are not turnkey. They require Linux/WSL2 with `bubblewrap`, a patched
devtool binary, testnet wallets, a gate home, an operator-provisioned inventory, and a worker
config. Those private inputs are excluded from the release.

```bash
scripts/web/start-all.sh
scripts/web/refresh-health.sh
# UI and API: http://127.0.0.1:8787/
scripts/web/stop-all.sh
```

The scripts fail closed when private inputs or the patched binary are missing. Use
[`env.example`](env.example) as a path/variable reference. The local setup is not a public
deployment.

## Repository map

| Path | Contents |
|---|---|
| `apps/web/` | Browser UI, responsive styles, and artwork |
| `apps/api/` | HTTP API, store, worker, gate adapter, M2 tests |
| `packages/contracts/` | Shared TypeScript API/health/receipt types |
| `scripts/web/` | Prepared local gate/worker/API lifecycle and provisioning |
| `scripts/check.sh` | Build, typecheck, syntax, and M2 checks |
| `scripts/build-gate.sh` | Pinned upstream clone, patch, and release build |
| `docs/DEVELOPMENT.md` | Codespace, gate-build, and private-state setup boundaries |
| `tests/m3-fixtures/` | Test-only UI state fixtures and Chrome runner |
| `tests/gate/` | Optional private-state gate regression and boundary tests |
| `docs/stage0b/` | Gate source snapshot, probes, and review notes |
| `docs/stage0b_changes.diff` | Complete gate development-tree diff |
| `docs/upstream/zcash-devtool/` | Pin, reproduction commands, binary hash, licenses |
| `docs/evidence/` | Selected sanitized testnet and UI evidence |

Release packaging excludes internal planning folders, redundant reports, screenshots,
prototypes, caches, generated binaries, wallets, gate state, databases, sessions, raw PCZTs,
and private evidence.

## Evidence

Selected sanitized evidence is in [`docs/evidence/README.md`](docs/evidence/README.md).
Testnet transactions are deliberately published as proof. Raw PCZTs, approval MACs, session
IDs, and recipient addresses in retained evidence are absent or redacted; testnet txids,
heights, statuses, and SHA-256 hashes remain.

| Check | Result |
|---|---|
| Matching payment, API path | txid `59193d22f0205451f39b5b463963c9fdec47c0c4a08c603ec8c26e8bf727e39a`, height 4526817 |
| Matching payment, browser path | txid `2dc1c04f73bb7525f6ca5dfc62219da2109da37641719635c5a09cc82417fcab`, height 4526860 |
| Changed recipient/memo | Rejected by the gate; no txid or signature |
| Restart retention | Same job, approval, and artifact hashes before/after restart; no rebroadcast |
| M2 integration tests | 5/5 pass with an isolated synthetic worker |
| M3 real browser matrix | Zero overflow, undersized targets, missing labels, or console errors across tested pages |
| M3 fixture-only states | Six missing states pass 28 page audits with 0 errors; test-only |

Screenshots from the local evidence set are excluded from this release to avoid publishing
unredacted recipient addresses.

## Limitations

- Testnet only. No mainnet, multisignature, arbitrary payouts, recurring budgets, or custom
  cryptography.
- No independent security audit. The gate and upstream dependencies are a prototype, not
  production custody software.
- Real live UI integration is unverified for no-approval, no-funds, loading,
  queued/busy/signed, fresh pending, broadcast-unknown, and gate-unavailable states because
  generating them would consume the final demo set or induce a live failure. Six states have
  separate fixture-only coverage; that is not transaction proof.
- The local sandbox is a mount boundary under one UID, not a VM.
- No public host, HTTPS certificate, second-network access, or judge availability period is
  established.
- The tested gate binary was built from a patched local tree; exact upstream pin, diff, build
  command, and tested hash are included, but a rebuild can differ by toolchain.
- Wallets, identities, approval MACs, gate home, raw PCZTs, session IDs, and raw logs are
  excluded. Pre-restart raw artifacts are not reproducible from public evidence.

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and the
[judge guide](docs/JUDGE_GUIDE.md).

</details>

## License

Original Airlock Inspector code, documentation and original/adapted assets are
MIT-licensed under the repository-wide [`LICENSE`](LICENSE), including
**Copyright (c) 2026 Stephen Gabriel**. The existing Airlock-contributor and
[UI starter/SVG MIT notice](apps/web/LICENSE) are retained, not replaced.

Third-party Rust/Zcash code compiled into redistributed WASM is **not relicensed as
our MIT work**. Its own license alternatives, required BSD/Unicode notices and
Rust standard-library notices are preserved in the
[bundled third-party license text](experiments/browser-inspector/web/THIRD_PARTY_LICENSES.txt).
The static package also carries the original/starter MIT texts in `LICENSE.txt`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the audited scope and
preserved historical upstream notices.
