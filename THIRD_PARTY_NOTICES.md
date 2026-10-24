# Third-party notices

Airlock's original application code, browser adapter, scripts, and documentation are
licensed under the MIT License in [`LICENSE`](LICENSE).
The repository-wide license covers original Airlock Inspector code/documentation
and original/adapted assets, with **Copyright (c) 2026 Stephen Gabriel**.
The existing Airlock-contributor and supplied UI-starter notices are retained.
This does not relicense third-party material under our copyright.

## Current Airlock Inspector submission and redistributed WASM

Inspector is the static browser-local app at https://airlock-inspector.pages.dev/.
Unlike the historical prototype below, it redistributes a compiled Rust/WASM
library, not just source references. A root MIT notice alone is insufficient.

The deployment package now includes:

- [`LICENSE.txt`](experiments/browser-inspector/web/LICENSE.txt): the full root MIT
  notice and the unchanged [`apps/web/LICENSE`](apps/web/LICENSE) for the starter
  and adapted cube/SVG artwork.
- [`THIRD_PARTY_LICENSES.txt`](experiments/browser-inspector/web/THIRD_PARTY_LICENSES.txt):
  per-package versions/declared terms, all collected upstream copyright/license
  texts and the tested Rust 1.99.1 standard-library notices, including exceptions.
  Exact repeated texts are consolidated without removing their attribution mappings.

### Dependency/license review

The review used both pinned manifests/locks and the actual cached package license
files. For browser redistribution, `cargo metadata --offline --locked
--filter-platform wasm32-unknown-unknown --format-version 1` from the Inspector
crate identifies a conservative reachable **107-package resolution graph**.
It includes optional/host build/proc-macro dependencies and is not a claim that
all listed code is linked into the final WASM. Fixture-generator-only native
dependencies are not browser runtime dependencies.

| Component | Pinned version/revision | Declared license / distribution choice |
|---|---|---|
| `pczt`, `zcash_protocol`, `zcash_encoding` | librustzcash `eb38d7a373661179dbc083a2fd58b3a6c9b25818` | MIT OR Apache-2.0; MIT selected |
| `orchard` | 0.16.0 | MIT OR Apache-2.0; MIT selected |
| `zcash_note_encryption` | 0.5.1 | MIT OR Apache-2.0; MIT selected |
| `serde_json`, `hex` and most other crates | Exact versions in Inspector `Cargo.lock` and bundled inventory | Their MIT/Apache alternatives are retained; MIT selected where permitted |
| `subtle` | 2.6.1 | BSD-3-Clause; full copyright, conditions, disclaimer and non-endorsement clause retained |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0; MIT plus the additional Unicode terms retained |
| `constant_time_eq` | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0; MIT-0 selected, original alternatives retained |
| Rust standard library/toolchain notices | Tested compiler 1.99.1 | MIT OR Apache-2.0 with per-file/dependency exceptions; original library copyright inventory retained |

Legacy `MIT/Apache-2.0`, `Unlicense OR MIT` and `Zlib OR MIT OR Apache-2.0`
alternatives are used under MIT where offered. This is **not** a claim that
every upstream file has our MIT license. BSD, Unicode and other per-file
requirements still belong to their own code. No dependency source was modified
for this submission documentation/license update.

The Rust library inventory conservatively includes multi-platform dependencies
that may not be linked into wasm32 with `panic=abort`; it is not a statement that
every optional/system license mentioned there applies to this binary.
The toolchain's `COPYRIGHT-library.html` was converted to text, preserving
attributions/exceptions and using references for identical preformatted texts.
MIT and Apache standard-library texts are also included.

Four crates omit license texts from their packaged directories. Their MIT text
was recovered from the exact upstream revision recorded in `.cargo_vcs_info.json`:
`blake2b_simd` (`47714dc3c424e82213d7f2eb4a833e3843017be5`),
`defmt-parser` (`4a8cdb44891ed57b8ff5a023b6bec7137c48708f`),
`ff_derive` (`8cf62cd9c7a37ee8c4abb0b89308df8e873b21c3`) and
`halo2_poseidon` (`31bae80e65763594e455101911f3fc3f7da4ed21`).
The source URLs are recorded beside those texts. The `pczt` crate uses its
pinned workspace-root license files.

### Reproduction and publication boundary

The source notice texts are committed and copied by the existing explicit
allowlist, with no new runtime dependency or automatic fetch. Changing dependency
pins/features or the Rust toolchain requires reviewing/updating the inventory;
`build.mjs` packages the notices but does not independently audit new dependencies.
See the [technical README](experiments/browser-inspector/README.md) for the
cached-metadata review procedure.

The new package has **19 files**, versus the previously uploaded 17. **It needs
an owner-performed Cloudflare Pages Direct Upload to publish these notices.**
GitHub pushes do not update the site. No re-upload or deployment was performed
in this change. Original worker/WASM checks and original Airlock state were not changed.

## Preserved original signing-gate prototype notices

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

Inspector and the preserved testnet signing-gate are unaudited prototypes. The presence of an upstream license does not imply that
Airlock has been audited, endorsed by upstream maintainers, or is suitable for production
custody of funds.
