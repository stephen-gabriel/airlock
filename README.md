# Airlock

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

## License

Original Airlock code is licensed under the MIT License in [`LICENSE`](LICENSE). The
delivered UI starter and SVG artwork retain their MIT notice at
[`apps/web/LICENSE`](apps/web/LICENSE). Upstream Zcash components retain their own licenses;
see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the preserved upstream license
texts under [`docs/upstream/zcash-devtool/`](docs/upstream/zcash-devtool/).
