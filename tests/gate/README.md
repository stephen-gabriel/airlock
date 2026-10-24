# Gate integration tests

These are optional, private-state tests for the patched `zcash-devtool` gate. They are not
part of `scripts/check.sh` because a fresh checkout has no testnet wallet or identity.

`regression.sh` covers memo bytes, approval IDs and paths, crash/recovery, replay and
concurrency, abandon/lock behavior, tip handling, network binding, and corrupt state.
`boundary.sh` checks that the proposer sandbox cannot read the wallet or gate state, cannot
sign locally, and cannot create an approval that the operator daemon accepts.

Neither script broadcasts a transaction. Both create temporary PCZTs, approvals, and signed
artifacts under `${AIRLOCK_GATE_TEST_DIR:-${TMPDIR:-/tmp}/airlock-gate-tests}`. They never
use the demo inventory and must not be pointed at the frozen demo wallet unless intentionally
isolated.

## Prerequisites

- Linux with `unshare` user and mount namespaces for `boundary.sh`; WSL2 is not sufficient
  for every host configuration.
- A patched `zcash-devtool` binary.
- A disposable funded testnet sender wallet, its age identity, and a recipient UA.
- `python3`, `flock`, and standard shell tools.

Set the same paths used by the local services:

```bash
export AIRLOCK_DEVTOOL_BIN=$HOME/airlock-build/zcash-devtool/target/release/zcash-devtool
export AIRLOCK_WALLET_ROOT=$HOME/airlock-state
export AIRLOCK_SENDER_WALLET=$AIRLOCK_WALLET_ROOT/sender
export AIRLOCK_IDENTITY_FILE=$AIRLOCK_WALLET_ROOT/sender-age.txt
export AIRLOCK_RECIPIENT_UA_FILE=$AIRLOCK_WALLET_ROOT/recipient.ua
export AIRLOCK_OPERATOR_HOME=$HOME
```

## Run

```bash
tests/gate/regression.sh
tests/gate/boundary.sh
```

`regression.sh` exits non-zero if any assertion fails and writes its transcript to
`$AIRLOCK_GATE_TEST_DIR/regression/work/results.txt`. `boundary.sh` similarly writes
`boundary_results.txt` and requires `unshare -Urm` to work.

These scripts are development tests, not evidence that the live application has consumed a
demo approval or broadcast a payment.
