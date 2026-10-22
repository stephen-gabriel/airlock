# Gate reproduction

Airlock's signing gate is a patched build of
[`zcash-devtool`](https://github.com/zcash/zcash-devtool). The complete development-tree
diff is the authoritative source:

- Upstream repository: `https://github.com/zcash/zcash-devtool.git`
- Upstream revision: `0b3436bb8d235c67cd36b800cb45a7b1b489c415`
- Patch: [`../../stage0b_changes.diff`](../../stage0b_changes.diff)
- Patch SHA-256: `35ae61579276e271dbb43b33f01bf739634b99bd88b526a1a58d4b75f7792281`
- Snapshot for review: [`../../stage0b/src/`](../../stage0b/src/)
- Tested binary SHA-256:
  `9a87f3daec59640011da655c53b6fbcc25ed0eb37631ac439a46efc1ea137f6a`
- Tested binary size: `104,139,200` bytes
- Upstream license: MIT OR Apache-2.0, preserved in this directory

The snapshot is illustrative. The diff is authoritative and includes the gate module, the
restricted socket protocol, approval MAC handling, PCZT validation and signing, fixture
helpers, and the `wallet/sync.rs` fix.

## Build

Prerequisites are Git, a Rust toolchain compatible with the upstream
`rust-toolchain.toml`, Cargo, and enough disk for a release build. The local evidence build
used roughly 1.6 GiB peak memory and 4.6 GB of build/disk space.

```bash
git clone https://github.com/zcash/zcash-devtool.git
cd zcash-devtool
git checkout 0b3436bb8d235c67cd36b800cb45a7b1b489c415
git apply --check /path/to/Airlock/docs/stage0b_changes.diff
git apply /path/to/Airlock/docs/stage0b_changes.diff
cargo build --release --locked
sha256sum target/release/zcash-devtool
```

Or, from the Airlock repository:

```bash
scripts/build-gate.sh
```

That script clones into `$HOME/airlock-build/zcash-devtool` (override with
`AIRLOCK_BUILD_DIR` or `AIRLOCK_DEVTOOL_DIR`), checks the exact revision, applies the patch
once, builds with `--locked`, and reports the binary hash. It does not modify this
repository. Set `AIRLOCK_REQUIRE_EXACT_GATE_SHA256=1` if a byte-for-byte evidence-binary
match is required.

A rebuild can produce a different hash when the Rust toolchain differs. The pin and patch
are fixed; the exact compiler environment used for the evidence binary was not preserved as
a reproducible container.

## Restricted interface

The operator-only commands are `approve`, `approvals`, `validate`, `sign`, and `serve`.
The untrusted proposer reaches the gate only through `submit` on a private Unix socket,
using the fixed `ALG1`/`ALR1` protocol. That path accepts an approval ID and PCZT bytes; it
does not accept wallet, identity, gate-home, or output-path configuration and cannot create
or widen an approval.

The OS mount boundary is part of the security model. Same-UID arbitrary code is not
defended against. See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) and
[`../../LIMITATIONS.md`](../../LIMITATIONS.md).
