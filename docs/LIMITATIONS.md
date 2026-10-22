# Limitations

Airlock is a hackathon prototype for a constrained testnet signing flow. It is not
production custody software.

## Scope

- **Testnet only.** No mainnet path is supported or exercised. There is no production
  wallet, multisignature, recurring budget, arbitrary payout, or custom cryptographic
  primitive.
- **Single-payment controls only.** An approval fixes one recipient, amount, memo policy,
  maximum fee, and expiry. There is no approval-creation or widening route in the public
  API.
- **Not audited.** The gate, the upstream Zcash dependencies, the sandbox setup, and this
  release have not had an independent security audit.

## Deployment and operation

- **No public deployment.** There is no public demo URL, HTTPS reverse proxy, second-network
  test, or judge-availability period in this release. A localhost URL is not deployment
  readiness.
- **Prepared-node reproduction.** The live app needs Linux or WSL2 with `bubblewrap`, Node.js
  24+, a patched `zcash-devtool`, testnet wallets, a gate home, an operator inventory, and a
  worker config. Those private inputs are intentionally not distributed. The API tests and
  fixture UI checks do not need them.
- **No turnkey container.** The repository has local lifecycle scripts, not a Docker image,
  systemd unit, managed host, or TLS deployment.
- **Health expires.** The worker only syncs during a build or an explicit
  `scripts/web/refresh-health.sh` call. After 300 seconds, health reports `degraded`/stale
  until another read-only sync. This is intentional.
- **Sandbox scope.** The local gate/worker/API separation is a bubblewrap mount boundary
  under the same runtime UID. It is not a VM and does not defend against same-UID arbitrary
  code.

## Verification coverage

- **Synthetic tests.** The five M2 API tests use an isolated synthetic worker. They exercise
  health, sessions, idempotency, quota, resume, and broadcast reconciliation, but they are
  not live transaction tests.
- **Partial live UI coverage.** Live states that could not be produced without consuming the
  final demo set or inducing a failure were not exercised in the live app. Six states have
  visibly marked, read-only fixture coverage: no approvals, no funds, signed, pending,
  broadcast-unknown, and gate-unavailable. Fixtures do not prove real signing, broadcast,
  confirmation, or recovery.
- **No modal coverage.** The live app has no modal dialogs, so Escape/focus-loop behavior is
  not exercised.
- **Browser matrix is historical.** The recorded checks used the owner's local API and browser
  setup. They are evidence, not a current CI guarantee. The fixture runner requires Chrome or
  Chromium plus `CHROME_PATH` if it is not in a standard location.

## Evidence and reproducibility

- **Sanitized evidence only.** Raw PCZTs, approval records and MACs, session IDs, wallet
  identities, seeds, inventories, worker configs, state databases, and raw logs are excluded.
  Retained testnet txids, heights, statuses, and hashes are public proof; redacted recipient
  addresses are not reproducible from this repository.
- **Gate rebuild variance.** The exact upstream pin and complete patch are included. A
  byte-for-byte match to the evidence binary is not guaranteed across Rust toolchains,
  targets, or dependency caches. The recorded binary hash is
  `9a87f3daec59640011da655c53b6fbcc25ed0eb37631ac439a46efc1ea137f6a`.
- **No residual demo inventory.** The release contains no funded wallet, approval set, or
  demo inventory. Running a live payment requires the owner to provision new private state.
