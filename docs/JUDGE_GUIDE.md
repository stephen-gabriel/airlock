# Judge guide

This is the shortest review path. The project is a local testnet prototype, not a hosted
demo.

## 1. Read the boundary

- [README](../README.md) — product and status
- [ARCHITECTURE.md](ARCHITECTURE.md) — components and trust boundaries
- [LIMITATIONS.md](LIMITATIONS.md) — what is and is not proven
- [Gate reproduction](upstream/zcash-devtool/README.md) — exact upstream pin and patch

The central claim is narrow: an application can propose a shielded testnet payment, but a
separately confined gate releases a signature only when the actual PCZT matches a
single-use operator approval.

## 2. Run the reproducible checks

Requires Node.js 24+ and npm:

```bash
cd apps/api
npm ci
cd ../..
scripts/check.sh
```

`scripts/check.sh` syntax-checks the browser and fixture files, typechecks and builds the
API, and runs the five M2 tests. Run it on Linux or WSL2; the M2 suite creates a Unix socket.
The checks use a synthetic worker and consume no approval, wallet, inventory, or testnet
funds.

To check the six fixture-only browser states (optional, needs Chrome/Chromium):

```bash
node tests/m3-fixtures/run.mjs
```

Set `CHROME_PATH` if the browser is not standard, or `AIRLOCK_FIXTURE_OUT` to choose an
output directory. Fixture pages are marked `TEST FIXTURE - NOT LIVE`.

## 3. Inspect the gate

- Patch: [`docs/stage0b_changes.diff`](stage0b_changes.diff)
- Readable snapshots: [`docs/stage0b/src/`](stage0b/src/)
- Pinned upstream: `0b3436bb8d235c67cd36b800cb45a7b1b489c415`
- Tested binary:
  `9a87f3daec59640011da655c53b6fbcc25ed0eb37631ac439a46efc1ea137f6a`

Useful review points:

- `docs/stage0b/src/approval.rs` — single-use approval state, MAC handling, memo policy
- `docs/stage0b/src/validate.rs` — PCZT checks and binding before signing
- `docs/stage0b/src/mod.rs` — operator commands versus the restricted `submit` socket
- `apps/api/src/worker.ts` — wallet/proposal/broadcast path and health sync
- `apps/api/src/main.ts` — browser-facing session, job, and receipt routes

`scripts/build-gate.sh` reproduces the patched release build in
`$HOME/airlock-build/zcash-devtool`. It does not touch this repository. A rebuild may have a
different hash if the Rust toolchain differs.

## 4. Read selected evidence

[`docs/evidence/README.md`](evidence/README.md) maps the retained testnet transactions,
policy rejections, API tests, browser checks, and fixture isolation. The short version:

- Matching payment, API path:
  `59193d22f0205451f39b5b463963c9fdec47c0c4a08c603ec8c26e8bf727e39a`, height `4526817`.
- Matching payment, browser path:
  `2dc1c04f73bb7525f6ca5dfc62219da2109da37641719635c5a09cc82417fcab`, height `4526860`.
- Changed recipient and changed memo: rejected with no signature or txid.
- Restart retention: same job/approval/artifact hashes across restart, no rebroadcast.
- M2: 5/5 synthetic-worker tests pass.
- M3: real browser matrix passed across the reachable states; six missing live states have
  separately marked fixture coverage only.

## 5. What the live app needs

The live UI and API are included and build from source, but this repository does not include
wallet seeds, identities, approval MAC keys, gate state, inventory, sessions, or raw PCZTs.
To run the prepared services locally, the operator must supply those private inputs and run:

```bash
scripts/web/start-all.sh
scripts/web/refresh-health.sh
# http://127.0.0.1:8787/
scripts/web/stop-all.sh
```

See [README](../README.md) and [env.example](../env.example) for the expected paths. The
scripts fail closed when the private inputs or patched binary are missing.

## What not to infer

- No public deployment or HTTPS endpoint is included.
- Fixture UI checks are not transaction proof.
- Sanitized evidence is not independently reproducible without the excluded private state.
- The gate is not audited and is not suitable for mainnet custody.
