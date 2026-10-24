# Development setup

This repository is sufficient for application, UI, contract, and synthetic-test work in a
fresh GitHub Codespace. It is not sufficient to run the live testnet demo without private
state.

## Application and UI

Install Node.js 24 or newer, then:

```bash
cd apps/api
npm ci
cd ../..
scripts/check.sh
```

`scripts/check.sh` typechecks and builds the API, syntax-checks the browser and fixture
files, and runs the five M2 tests. The tests use a synthetic worker and need no wallet,
gate home, inventory, or testnet funds. Linux and Codespaces can bind the synthetic Unix
socket; Windows needs WSL2.

The optional browser fixture runner needs Chrome or Chromium:

```bash
node tests/m3-fixtures/run.mjs
```

Set `CHROME_PATH` if the browser is outside the standard locations. Fixture pages are
test-only and never call the live API.

## Gate development

The patched gate is not vendored. Install a Rust toolchain, then use:

```bash
scripts/build-gate.sh
```

The script clones the pinned upstream revision into
`${AIRLOCK_BUILD_DIR:-$HOME/airlock-build}/zcash-devtool`, applies
`docs/stage0b_changes.diff`, builds with `--locked`, and prints the binary hash. Budget
roughly 4.6 GB of build disk and 1.6 GiB of peak build memory. Use
`AIRLOCK_REQUIRE_EXACT_GATE_SHA256=1` only when a byte-for-byte match to the recorded
evidence binary is required; toolchain differences can change the hash.

The optional tests under [`tests/gate/`](../tests/gate/) exercise the gate but require a
disposable funded testnet wallet, identity, recipient UA, and namespace support. They do
not broadcast or use demo inventory. See [`tests/gate/README.md`](../tests/gate/README.md).

## Live end-to-end development

The prepared services need Linux or WSL2 with `bubblewrap`, a patched devtool, testnet
wallets, an age identity, a recipient UA, a gate home, an operator inventory, and a worker
config. Those values are intentionally absent from Git. Use [`env.example`](../env.example)
as the path and variable reference, create private state outside the repository, then run:

```bash
scripts/web/start-all.sh
scripts/web/refresh-health.sh
scripts/web/stop-all.sh
```

The scripts fail closed when private inputs are missing. Do not commit wallet databases,
identity files, approval records, MAC keys, inventory, session state, raw PCZTs, logs, or
generated binaries. Do not consume the demo inventory to test a UI state.

## Codespace caveats

- A Codespace normally does not include the patched binary, Rust toolchain, Chrome, or
  `bubblewrap`. Install only the pieces needed for the part you are changing.
- `boundary.sh` uses `unshare` user and mount namespaces; some container hosts block this.
- The repository does not include cloud hosts, DNS, TLS certificates, systemd units, a
  devcontainer, wallets, faucet funds, or a live demo set.
- `node_modules`, `dist`, and fixture artifacts are generated locally and ignored.
- A green check run is not proof of signing, broadcast, confirmation, or recovery.
