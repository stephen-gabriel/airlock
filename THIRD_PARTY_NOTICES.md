# Third-party notices

Airlock's original application code, browser adapter, scripts, and documentation are
licensed under the MIT License in [`LICENSE`](LICENSE).

This repository does not vendor the full Zcash Rust dependency tree or the
`zcash-devtool` checkout. It includes a patch, selected gate source snapshots, and upstream
license texts. Those files remain subject to their upstream licenses.

## zcash-devtool and Zcash Rust components

- Component: `zcash-devtool`
- Upstream: `https://github.com/zcash/zcash-devtool.git`
- Revision: `0b3436bb8d235c67cd36b800cb45a7b1b489c415`
- License: **MIT OR Apache-2.0**
- Local changes: [`docs/stage0b_changes.diff`](docs/stage0b_changes.diff) and
  [`docs/stage0b/src/`](docs/stage0b/src/)
- Reproduction, tested binary hash, and build command:
  [`docs/upstream/zcash-devtool/README.md`](docs/upstream/zcash-devtool/README.md)
- Preserved licenses:
  [`LICENSE-MIT`](docs/upstream/zcash-devtool/LICENSE-MIT) and
  [`LICENSE-APACHE`](docs/upstream/zcash-devtool/LICENSE-APACHE)
- Upstream MIT copyright: Copyright (c) 2020-2023 The Electric Coin Company

The patch and source snapshots are derivative works of `zcash-devtool`. The full dependency
set, including `librustzcash` crates and other Cargo dependencies, is resolved from the
pinned upstream `Cargo.lock`; consult that manifest and the upstream repositories for the
authoritative license of each crate. No Cargo source or build cache is committed.

## Delivered user interface

- Component: Airlock/Fieldwork UI starter and SVG artwork
- License: **MIT**
- Preserved text: [`apps/web/LICENSE`](apps/web/LICENSE)
- Copyright (c) 2026 Airlock contributors

The live adapter in `apps/web/app-live.js` is original Airlock code covered by the root
MIT license. The starter artwork and UI source retain the supplied MIT notice.

## Development tooling

These packages build or test the API. They are installed under `apps/api/node_modules` and
are not committed or served by the application.

| Component | Version | License |
|---|---|---|
| Node.js | 24.x | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| `@types/node` | 24.19.2 | MIT |
| `undici-types` | resolved by TypeScript tooling | MIT |

## Runtime system components

The local demo invokes `bubblewrap` and a system Node.js runtime. These are host
dependencies, not files distributed in this repository. `bubblewrap` is licensed under
LGPL-2.1-or-later. The demo also connects to a public Zcash testnet lightwalletd endpoint;
that service and the Zcash network software are not bundled here and remain subject to
their own licenses and terms.

## No warranty or audit

Airlock is a testnet prototype. The presence of an upstream license does not imply that
Airlock has been audited, endorsed by upstream maintainers, or is suitable for production
custody of funds.
