# Architecture

Airlock separates payment intent from signing authority. The browser can request an
allowlisted testnet payment, but it cannot create or widen an approval, read wallet
material, or invoke the signer directly.

```text
Browser (HTML/CSS/JS)
  | same-origin HTTP, HttpOnly session cookie
  v
API / proposer (Node 24 + TypeScript)
  | private Unix socket, fixed commands
  v
Worker (wallet sync, PCZT build, proving, broadcast)
  | private Unix socket, ALG1/ALR1 submit
  v
Rust gate (PCZT validation -> approval binding -> signature)
  |
  v
Zcash testnet
```

## Components

| Component | Code | Responsibility |
|---|---|---|
| Browser UI | `apps/web/` | Shows approval terms, proposal checks, jobs, and receipts |
| Public API | `apps/api/src/main.ts` and `store.ts` | Sessions, inventory, jobs, receipts, quota, static UI |
| Worker | `apps/api/src/worker.ts` and `gate.ts` | Wallet sync, proposal creation, proving, gate submission, broadcast reconciliation |
| Gate | `docs/stage0b/src/` and `docs/stage0b_changes.diff` | MAC-protected approvals, PCZT validation, binding, signing |
| Contracts | `packages/contracts/api.ts` | Shared public response and health types |

The worker has the sender wallet and broadcast path. The API has neither. The gate owns its
approval store and MAC key; the API and browser never receive them. The local lifecycle
scripts run all three services under `bubblewrap` with separate mounts and private sockets.

## Approval and signing flow

1. The operator creates a single-payment approval out of band: recipient, amount, exact memo,
   maximum fee, and expiry. The public API has no approval-creation route.
2. The API assigns an available operator-provisioned set to a demo session. A session can
   only select approvals already assigned to it.
3. The worker builds and proves the proposal using the patched `zcash-devtool`.
4. The worker submits the PCZT to the gate over the restricted socket.
5. The gate validates the PCZT and its approval record, then binds network, recipient,
   amount, fee, memo, expiry, and output layout before signing.
6. A mismatch is rejected with a specific code and no signature. A successful result is
   returned to the worker for broadcast.
7. Retry and resume reuse the retained job/artifact. Broadcast-unknown is reconciled against
   the original txid instead of rebuilding or re-signing.

Approval terms and gate-derived inspection are displayed separately. A receipt is an
application record, not a consensus proof or an audit certificate.

## Data and trust boundaries

- Wallet, identity, gate home, inventory, sessions, receipts, and raw PCZTs are runtime state
  outside this repository. They are not distributed to judges.
- The API stores only its own state and talks to the worker over a Unix socket.
- The gate has no network namespace in the local setup, mounts the wallet read-only, and
  keeps approvals and the MAC key in its own gate home.
- The browser is untrusted. The API validates ownership, allowlists scenarios, enforces a
  request-body limit and rate/session quotas, and uses an HttpOnly session cookie.
- Health is freshness-limited. After 300 seconds without a sync it reports `degraded`/stale
  instead of claiming a current chain view. `scripts/web/refresh-health.sh` performs a
  read-only sync; it does not consume a job, approval, inventory set, or signature.

## API surface

Powering the UI:

| Route | Purpose |
|---|---|
| `GET /api/health` | Mode, signer/funding/freshness, remaining sets and quota |
| `POST /api/demo/sessions` | Allocate a rate-limited session from finite inventory |
| `GET /api/session` | Resume the current session |
| `GET /api/approvals`, `GET /api/approvals/:id` | Session-scoped approval terms |
| `POST /api/jobs` | Build/check/sign an allowlisted scenario with an idempotency key |
| `GET /api/jobs/:id` | Poll an owned job |
| `POST /api/jobs/:id/resume` | Resume the same job and spool |
| `POST /api/jobs/:id/broadcast` | Reconcile/reuse the retained artifact |
| `GET /api/receipts`, `GET /api/receipts/:id` | Application receipts and detail |

Public errors use a stable envelope with `mode`, `requestId`, `error.code`, `retryable`, and
`stage`. Raw subprocess output and secrets are not exposed.

## Local isolation

`scripts/web/start-all.sh` starts gate, worker, and API with bubblewrap. The gate gets a
read-only wallet mount, its own writable gate home, and no network. The worker gets the
wallet, gate socket, and network, but not the gate home. The API gets neither the wallet nor
the gate home, only the worker socket and its own state.

This is a mount-namespace boundary for the prepared local setup, not a VM. Same-UID arbitrary
code is out of scope. See [LIMITATIONS.md](LIMITATIONS.md) for the deployment and audit
boundaries.
