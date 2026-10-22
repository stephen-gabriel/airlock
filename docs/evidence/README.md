# Selected evidence

This directory contains a minimal, sanitized subset of the testnet and UI evidence. Raw
PCZTs, approval records and MACs, wallet/gate state, session IDs, inventories, worker
configurations, and raw logs are excluded.

## Testnet results

| Check | Retained result |
|---|---|
| Matching payment, API path | [`m1-api-matching.json`](m1-api-matching.json) — txid `59193d22f0205451f39b5b463963c9fdec47c0c4a08c603ec8c26e8bf727e39a`, height `4526817` |
| Matching payment, browser path | [`m1-browser.json`](m1-browser.json) — txid `2dc1c04f73bb7525f6ca5dfc62219da2109da37641719635c5a09cc82417fcab`, height `4526860` |
| Changed recipient | [`m1-recipient-rejected.json`](m1-recipient-rejected.json) — `E_POLICY_RECIPIENT`, no signature |
| Changed memo | [`m1-memo-rejected.json`](m1-memo-rejected.json) — `E_POLICY_MEMO`, no signature |
| Earlier sanitized Stage 0A payment | [`stage0a-payment.txt`](stage0a-payment.txt) — txid `49e805a8e56ccecb8781f66e5d4ce805fda67d271dd8c0691dd7770135ce79dc` |

Recipient addresses and session IDs in the JSON are replaced with redaction markers.
Testnet txids, heights, statuses, amounts, memos, and hashes are retained where they are
public proof. The redacted fields cannot be reconstructed from this repository.

## Build and browser checks

| Check | Retained result |
|---|---|
| API tests | [`m2-api-tests.txt`](m2-api-tests.txt) — 5/5 pass with an isolated synthetic worker |
| Live UI checks | [`m3-checks.txt`](m3-checks.txt) — build, typecheck, browser syntax, and M2 run |
| Fixture checks | [`m3-fixture-checks.txt`](m3-fixture-checks.txt) — six scenarios, 28 page audits, zero failed assertions |
| Fixture isolation | [`m3-fixture-isolation.txt`](m3-fixture-isolation.txt) — inventory and `set-m1c` hashes unchanged by the fixture run |

The M2 tests are synthetic integration tests; they are not live transaction tests. The
fixture pages are marked `TEST FIXTURE - NOT LIVE` and do not prove signing, broadcast,
confirmation, or recovery.

## Integrity

[`SHA256SUMS.txt`](SHA256SUMS.txt) covers every file in this directory except itself.
Screenshots from the original local evidence set are excluded from this release to avoid
publishing unredacted recipient addresses. The original testnet transactions remain
independently checkable on a testnet explorer by txid.
