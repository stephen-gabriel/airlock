# M3 fixture-only UI checks

This directory is a **test-only** environment for browser states that cannot be produced
without spending the final demo set or interrupting live services. It is not imported by
`apps/api`, is not served by the live static map, and is not part of the public build.

Run it with Chrome or Chromium installed. Set `CHROME_PATH` if it is not in a standard
location:

```bash
node tests/m3-fixtures/run.mjs
CHROME_PATH=/path/to/chrome AIRLOCK_FIXTURE_OUT=/tmp/airlock-fixtures node tests/m3-fixtures/run.mjs
```

The runner starts a loopback fixture server on a random port, serves the real
`apps/web/index.html`, `styles.css`, `live.css`, and `app-live.js`, and returns deterministic
API responses for:

- `no-approvals`: empty test inventory
- `no-funds`: controlled `funding: insufficient` response
- `gate-unavailable`: a loopback test gate stub is started, confirmed reachable, then
  disconnected before the browser loads; only that stub is stopped
- `signed`, `pending`, `broadcast_unknown`: synthetic jobs and receipts matching the
  response shapes in `packages/contracts/api.ts`

These are UI fixtures, not integration or transaction tests. They do not prove signing,
broadcast, confirmation, or recovery. They do not read or modify real approvals, broadcast a
transaction, or start/stop live gate/worker/API processes.

Output is written to `tests/m3-fixtures/artifacts/` by default, which is ignored by Git.
Override it with `AIRLOCK_FIXTURE_OUT`. Keep this fixture evidence separate from the real
testnet evidence in `docs/evidence/`.
