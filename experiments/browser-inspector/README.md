# Airlock Inspector

**Current hackathon demo: https://airlock-inspector.pages.dev/**

The owner-published Cloudflare Pages site uses Direct Upload. GitHub pushes do not
update it. The previous upload had 17 files; the notice-complete package described
below now has 19 and requires an owner re-upload. No redeployment was performed
for the documentation/license update. See the
[submission README and upload checklist](../../README.md).

A static, browser-local disclosed-PCZT inspector and exact policy comparator.
The polished application runs the pinned upstream Rust checker as WASM.
There is **no API, wallet connection, signer, broadcast, telemetry, account or
external runtime dependency**.

**Scope verdict remains LIMITED-GO:** genuine disclosure-consistency checks, not
a transaction verifier, approval gate or payment receipt. A fabricated, unfunded
proposal can pass every implemented check. All binding statements are relative to
fields in the supplied PCZT, not an independently authorized transaction ID.

All work stays in `experiments/browser-inspector/` on `spike/browser-inspector`.
The existing signer/API, original UI source and original Desktop Airlock folder
are unchanged. Existing Cargo pins and the previous spike implementation were
reused, not replaced with simulated results. Source is maintained on the spike
branch; deployment remains a separate, manual action.

## Workflow and visual identity

1. **Load proposal:** choose/drop one local PCZT, or choose a clearly labeled
   public synthetic example: matching terms, altered amount, missing spend
   disclosure. Examples load an explicit intended policy alongside a synthetic
   unsigned partial. Their labels do not create results.
2. **Set intended policy:** enter raw receiver hex, decimal zat strings and the
   exact memo. Add, remove and reorder up to eight action outputs. Include
   zero-value/dummy outputs; no change inference. Metadata and static bounds are
   separately labeled. Advanced JSON retains the original strict schema.
3. **Inspect locally:** run actual WASM checks. Output-policy comparison and
   disclosure-check coverage have independent summaries. Missing nullifier,
   randomized-key or cross-address evidence stays visible even when output terms
   match. Technical JSON is expandable.

Input changes, Clear, new proposals and newer inspections cancel in-flight work
and remove stale results. Late file reads, examples and worker results cannot
replace current inputs/results.

### Usability refinement

Essential helper text, example descriptions, comparison explanations and right-panel
labels are at least 14px, with the existing ivory/evergreen/lime palette. The cube
SVG is unchanged (SHA-256
`bd0c18a4af37061ae62fa2c5d2ad2d0fb1d8a499b72ab855f6859eca80bff799`).
Each existing synthetic unsigned-partial example now describes what it illustrates,
has an explicit **Load example** action, and points to the existing intended-policy
and **Inspect locally** workflow. Nothing is automatically declared inspected.

Results retain expected/disclosed columns and add plain-language explanations:
policy-only differences, cryptographic disclosure inconsistencies, missing evidence
and reconstruction remain different states. `valueStatus`, `policyMismatch` and
`disclosedOutputStatus` expose raw disclosed-value comparisons separately from
binding evidence (`bindingStatus`). Raw agreement without binding is never a checked
match. The conservative existing `outputStatus`/`status` remain for compatibility.
Missing-disclosure coverage names both the missing data and the check it prevents.
Upstream detail stays expandable.

The warm ivory, evergreen, lime, typography, spacing and desktop comparison
layout derive from `apps/web/styles.css`. The mark comes from
`apps/web/assets/airlock-mark.svg`; the chamber geometry is the actual
`illustration()` in `apps/web/app-live.js`. The square artwork now explains
**proposal → local checks → evidence**. Its former signature/check endpoint is an
evidence document and lens. Only functioning workflow anchors remain. There are
no payment pages, signer controls, dashboard metrics or obsolete product navigation.

### Exact memo handling

- **Hex:** exactly 1,024 hex digits, all 512 bytes. No trimming, implicit padding,
  truncation or normalization. Spaces and wrong lengths are rejected.
- **Text:** UTF-8 with explicitly disclosed trailing-zero padding to 512 bytes.
  A byte count is shown. Oversized text and unpaired surrogates are rejected.
  Text uses LF line breaks and performs no Unicode normalization. CR/CRLF pastes
  are rejected rather than silently changed by a textarea; use hex for those bytes.
- Switching to text requires a byte-exact full-memo round trip. Arbitrary/invalid
  UTF-8 and CR-containing sequences stay in hex. The raw JSON always uses `memoHex`.
- No Unified Address support or new cryptographic implementation was added.

Result previews use fatal UTF-8 decoding, preserve Unicode without normalization,
and show control/format characters as bracketed tokens (NUL, CR, LF, TAB, BOM,
or a Unicode code point). Spaces and other invisible characters are counted.
Invalid UTF-8 gets no replacement-character/lossy fallback. Prefix byte counts and
trailing `0x00` counts are explicit; zeros are only *possible* padding, never
assumed to have been intentionally added. Expand **Padding & invisible bytes**
or **Exact hex** for details, including all original 512 bytes/1,024 hex digits.
The preview never supplies equality evidence. On mobile only, memo expected/
disclosed blocks stack to preserve readable line lengths.

## Supported checks and honest limits

Pre-release **NU7, transaction V6, V6 version-group ID, Ironwood-only, 1–8 actions,
256 KiB maximum**. Other versions/pools/mixed proposals get parser-only metadata
and an unsupported result. Invalid typed cryptographic fields are uncheckable.
This pinned snapshot is not a claim of activation on any live network.

| Property | Required PCZT information | Evidence and limit |
| --- | --- | --- |
| Recipient | Output raw 43-byte receiver, value, rseed; paired nullifier; supplied `cmx` | Upstream recomputes the note commitment. Compare the exact raw receiver, never the untrusted `user_address` label. |
| Amount | Above plus spend/output values, `rcv`, supplied `cv_net` | Note and per-action net value commitments, with monetary bounds. Does not establish a real input on chain. |
| Memo | Receiver/value/rseed, paired nullifier, note version, epk, encrypted note ciphertext; supplied or resolvable `cmx` | Upstream `Domain` plus `try_output_recovery_with_pkd_esk` authenticates the ciphertext using disclosed randomness. Compare all 512 bytes. No wallet secret/OVK input needed. Sender `out_ciphertext` is not checked. |
| Conditional fee | Every action's spend/output values and `rcv`, supplied `cv_net`, bundle balance, no other pools | Sum disclosed spends minus outputs, compare the bundle balance and per-action commitments, require a bounded nonnegative result, compare policy cap. Not a proven network-valid fee or ZIP-317 estimate. |
| Network | `coin_type`, branch/version | Field-policy comparison only. Coin type is unauthenticated metadata; branch/raw receiver do not establish a network. `networkVerified` is always false. |
| Expiry | Transaction expiry height | Static policy interval only, not current freshness. |
| Nullifier | Spend receiver/value/rho/rseed and disclosed FVK | Upstream recomputes nullifier and FVK/note compatibility. The file's FVK is not a trusted wallet identity. |
| Randomized key | Disclosed FVK and alpha | Upstream `rk` consistency, not signature validity/authorization. |
| Cross-address restriction | Flags and, when restricted, spend/output receivers | Upstream expanded-receiver comparison. Enabled cross-address transfers are not applicable, not a cryptographic success. |

Every output must appear in action order, including zero-value/dummy outputs.
No output is inferred to be change. Decimal zat values remain strings, not JS
floating-point monetary arithmetic. Heights and coin type follow the strict uint32 schema.

### Evidence states and review fixes

Presence is recorded before upstream V2 resolution:

- **Consistent:** disclosures agree with a supplied commitment or a supplied
  ciphertext authenticates, not a valid proof/signature.
- **Reconstructed:** an omitted commitment was derived, or plaintext was
  re-encrypted; no independently supplied field of that kind was checked.
- **Unavailable:** a required disclosure or binding is absent. Comparison rows
  expose `matchesClaim: null`, never a positive match.
- **Inconsistent:** commitment/authentication or disclosed balance checks fail.
- **Unsupported/uncheckable:** no output-policy success is returned.

`comparison.outputStatus` covers ordered output terms and conditional fee;
`metadataStatus` covers metadata/static bounds; `comparison.status` combines
those policy comparisons, not spend-check coverage. `disclosureCoverage()`
independently summarizes all supplied/reconstructed/unavailable/inconsistent
checks. The UI shows incomplete/inconsistent evidence even if output terms match.
Missing FVK, for example, leaves nullifier and randomized-key checks unavailable.
There is no overall safe/approved/funded/network-valid/unexpired status.

Rust uses explicit upstream missing-error variants rather than formatted-name
prefixes. Memo recovery reports `cmxSource` and explicitly distinguishes
authentication against a reconstructed `cmx` from an independently supplied `cmx`.

**Not verified:** ZK proofs; spend/binding signatures or transaction authorization;
actual funding, unique spends or unspentness; real-chain anchor/witness membership;
wallet/change ownership; chain activation, actual network, current expiry or
lock-time consensus; confirmations, settlement or payment completion; trusted
policy provenance, business authority or single-use reservations.

This application is not a replacement for the existing Airlock gate.

## Build and preview

Requirements: the pinned Cargo dependencies, Rust with `wasm32-unknown-unknown`,
Node 24, and installed Chrome/Chromium for browser tests. No `npm install` is needed.
All commands below are scoped to this experiment, not the full devtool.

### Fresh checkout: create the 19-file deployment package

The repository deliberately does **not** contain `dist/`, `web/inspector.wasm`,
`web/examples/` or `web/fixtures/`. The static host must receive the output of the
build below, not the checkout's `web/` directory. No release/downloaded WASM is
required: the pinned Rust source and deterministic public fixture generator create
all required artifacts.

From the repository root in a Linux/WSL shell with **Node 24**, run:

```sh
set -e
cd experiments/browser-inspector
rustup target add wasm32-unknown-unknown
cargo build --locked --release --lib --target wasm32-unknown-unknown
cargo run --locked --release --manifest-path fixtures/Cargo.toml --target-dir target/fixtures
node build.mjs
```

Output: **`experiments/browser-inspector/dist/`**, exactly 19 allowlisted files.
`node build.mjs` alone is the packaging step, but fails on a fresh checkout until
the preceding Rust build and fixture generation have produced its inputs.

Prerequisites not supplied by Git: Rust/Cargo with edition-2024 support (tested
with **1.99.1**), rustup and the `wasm32-unknown-unknown` standard library, a native
C linker for the fixture generator, Node 24, and initial network access to the
pinned public GitHub/crates.io dependencies. Chrome is needed only for the browser
suite, not packaging. No wallet, demo inventory, API, npm install or signing key
is required. The lock files include the cached/yanked dependency selections;
`--locked` preserves them. The fresh-checkout commands intentionally omit
`--offline`, which requires dependencies already cached.

On this Windows checkout, Rust runs in WSL Ubuntu and Node 24 can run in
PowerShell. Run the two Cargo commands from the experiment in WSL, then the
repository-root PowerShell packaging command shown below. Use Node 24 in whichever
shell runs `build.mjs`.

### Cached/offline development and checks

From `experiments/browser-inspector` in WSL/Linux:

```sh
# One-time, if the target is not already installed:
rustup target add wasm32-unknown-unknown

cargo build --offline --locked --release --lib --target wasm32-unknown-unknown
cargo run --offline --locked --release --manifest-path fixtures/Cargo.toml --target-dir target/fixtures

# Focused Rust checks:
cargo test --offline --locked --release --lib --target-dir target/unit
cargo clippy --offline --locked --release --lib --target wasm32-unknown-unknown -- -D warnings
cargo fmt --all -- --check
cargo fmt --manifest-path fixtures/Cargo.toml --all -- --check
```

`--offline` reuses the existing caches. On a fresh machine, fetch the same locked
dependencies first, without upgrading them. The initial spike reused the cached
devtool lock to resolve a cached yanked `inout` selection; the isolated lock files
preserve that selection. No main-app dependency upgrade or full devtool build.

From PowerShell in the repository root:

```powershell
node .\experiments\browser-inspector\build.mjs
node --test .\experiments\browser-inspector\inspector.test.mjs
node .\experiments\browser-inspector\browser-test.mjs

# Manual preview, static files only:
node .\experiments\browser-inspector\serve.mjs --dist
```

Open **http://127.0.0.1:8089**, choose a synthetic example, then **Inspect locally**.
Or choose your own local proposal and enter intended terms. Stop with Ctrl+C.
`serve.mjs` without `--dist` serves development `web/` including test-fixture routes.
There is no real-wallet/demo inventory loading.

`build.mjs` copies the built WASM and explicitly selected generated examples into
`web/` and the deployment directory. It requires the Cargo build and generator
above. Browser tests use their own temporary profile, start/stop loopback static
servers, write `evidence.json` and screenshots, then close their browser/server.
Set `CHROME_PATH` for another Chrome/Chromium executable.

## Exact deployment output, notice update awaiting owner upload

```text
experiments/browser-inspector/dist/
```

Repository-relative: **`experiments/browser-inspector/dist/`**.

Exactly **19 allowlisted files**:

- Fourteen app assets: HTML/CSS, seven JS modules, WASM, two local SVGs and
  `LICENSE.txt` / `THIRD_PARTY_LICENSES.txt`.
- `examples/matching.bin`, `examples/altered.bin`, `examples/missing.bin`,
  `examples/policy.json`: explicitly public disposable synthetic data only.
- `_headers`: application/worker CSP, WASM MIME and privacy headers.

`deployment-manifest.json`, outside `dist/`, records paths, sizes and SHA-256
hashes. A focused test verifies the exact inventory and every hash. The build
refuses unknown output files/directories rather than deleting user work.
It never recursively copies the repository.

Excluded: wallets, state, original raw PCZT inventory, private configuration,
full test fixtures/manifests, build caches, test runners/reports, browser profiles
and screenshots. All generated binaries and output directories are ignored.
The three selected examples derive only from the documented public seed; **never
fund their addresses**. No production transaction-valid fixture is distributed.

Serve the directory over HTTP(S); `file://` module/WASM fetching is not supported.
Node is a local preview tool, not an application backend. Hosts supporting
`_headers` can apply that file; other hosts must translate the same rules into
their response-header configuration, especially `application/wasm` and the
worker's `connect-src 'none'`. A source push does not deploy this output; hosting
configuration, publishing and provider pricing remain separate.

### Source-control boundary

Only Inspector source, both pinned Cargo manifests/locks, fixture-generator source,
tests, local SVG assets, build/preview definitions and documentation are committed.
`deployment-manifest.json` is retained as a small reference inventory (paths,
lengths and hashes only); `build.mjs` refreshes it for the generated package.
Generated binary inputs/outputs, `target/`, browser profiles, screenshots and the
browser-generated `evidence.json` remain ignored and are not part of the commit.
Documentation records the prior test outcomes; rerunning the browser suite creates
the local report/screenshots. Do not force-add these ignored outputs.

Before the prior source commit, the then-existing package's 17 entries, lengths and SHA-256
hashes were checked without rebuilding or rerunning the full already-passing suite:

```powershell
node --test --test-name-pattern="deployment contains exactly the allowlist" .\experiments\browser-inspector\inspector.test.mjs
```

That check requires the existing built package and generated native fixture
manifest, so run the fresh-checkout build first when those are absent. A clean
machine/network reconstruction was not repeated during source publication.

## Validation and screenshots

- **25 native/WASM synthetic cases:** the original 23 plus missing/inconsistent
  cross-address evidence. Independent expected-status assertions as well as native
  report parity. Altered, redacted, reconstructed, malformed and unsupported inputs.
- **18 focused Node regressions:** exact evidence semantics/memo bytes/schema;
  fetch+compile timeout, streamed size cap, retry and late completion; cancelled/
  superseded workers, postMessage failure, worker termination; exact deployment
  inventory/hashes; byte-preserving result previews, invisible-byte accounting,
  policy-versus-cryptographic explanations and specific blocked-check reasons;
  complete original/starter license retention and plain-text notice serving.
- **Prior unchanged Rust validation:** 2 tests, strict WASM-target Clippy with zero
  warnings, and both-crate formatting checks. Not rerun for this UI-only refinement;
  Rust, the fixture generator, dependency pins, WASM and worker code were unchanged.
- **Actual Chrome 155.0.8059.85:** file picker and all three examples run actual
  WASM; form/JSON sync, ordered eight-output editing, mismatch/incomplete states,
  clear/input-change cancellation, supersession, inert hostile text, worker
  deadline, real failed WASM request/retry and minimal deployment smoke. New checks
  use real WASM with hostile filenames/intended memos, invalid UTF-8 previews,
  policy-only versus ciphertext inconsistencies and exact expandable memo hex.
- **Desktop 1440 × 1100 and emulated mobile 390 × 844** screenshots inspected and
  refined against built `dist/`, not only development source. Mobile receiver fully
  visible; comparison uses expected/disclosed columns with a separate explanation
  row (memo blocks stack). Essential visible helper/result text is audited at
  minimum 14px and contrast ratio 4.5:1. Expanded memo hex also has no overflow.
  No horizontal overflow, unlabeled
  controls or dead workflow anchors in the mobile audit. Visible keyboard focus.
- **Zero external app requests and zero unexpected browser errors.** Only static
  GETs. The intentionally injected HTTP 503 WASM failure is recorded separately
  under `expectedErrors`, not hidden as a successful request. Test-only fixture
  GETs are not uploads.

`evidence.json` records per-asset hashes/sizes, actual requests, UI checks and
timings. WASM is **631,303 bytes raw / 238,676 bytes gzip**; sample linear memory is
**1,245,184 bytes**, not total Chrome memory. Desktop loopback timings are not
mobile-device/internet performance guarantees. Gzip sizes are computed; the
preview serves uncompressed assets. A harness expression syntax error on the
first extended browser attempt was corrected; subsequent full runs passed.
The first usability run also corrected an overly broad test selector that
mistook the valid disclosed-memo preview for an invalid expected-memo preview.
The prior full browser runs passed. All 18 current focused tests pass, including
the notice package update. Rust/full browser suites were not repeated for this
documentation/license-only update; the 17 original application/package entries
retain their prior hashes.

Screenshots (ignored, not deployed):

- `artifacts/desktop-workflow.png`, `artifacts/desktop-empty.png`
- `artifacts/desktop-matching-results.png`, `artifacts/desktop-altered-results.png`
- `artifacts/desktop-missing-results.png`, `artifacts/desktop-wasm-failure.png`
- `artifacts/mobile-workflow.png`, `artifacts/mobile-policy.png`
- `artifacts/mobile-results.png`

Built-output usability screenshots:

- `artifacts/dist-desktop-examples.png`, `artifacts/dist-desktop-results.png`
- `artifacts/dist-desktop-memo.png`, `artifacts/dist-desktop-policy-mismatch.png`
- `artifacts/dist-desktop-missing-results.png`, `artifacts/dist-desktop-missing-coverage.png`
- `artifacts/dist-mobile-examples.png`, `artifacts/dist-mobile-policy.png`
- `artifacts/dist-mobile-results.png`, `artifacts/dist-mobile-memo.png`
- `artifacts/dist-mobile-altered-results.png`, `artifacts/dist-mobile-missing-results.png`
- `artifacts/dist-mobile-missing-coverage.png`

No Firefox, Safari, physical mobile device, full original application suite,
full consensus/proof suite or completed fuzz/security audit was run.

### Synthetic fixture classification

`fixtures/src/main.rs` uses public disposable test seeds and upstream builders,
with no wallet, RPC, signing, proof generation or broadcast.

`unsigned-valid-partial` is a structurally usable, internally disclosure-consistent
**unsigned partial PCZT**, 110,000 zat in, 100,000 zat out, conditional balance
10,000 zat, exact synthetic memo. Its coherent witness/root describe a synthetic
tree, not a real-chain anchor. No proof, spend signature, dummy spending key or
final transaction. It is **not a network-valid final transaction**.

Other cases are parser-valid but inconsistent disclosures, redacted partials,
derived commitments, reconstructed ciphertext, changed metadata/expiry claims,
restricted-bundle coverage cases, hostile labels, unsupported scope, noncanonical
fields, truncated/bad-magic data and oversized rejection. None establishes
transaction validity. The generator/recorded evidence are reproducible material;
no existing wallet/demo PCZTs were used.

## Privacy and resource boundary

File bytes are read locally only after the 256 KiB size check, transferred to
one worker/one WASM instance with **no imports**, and never uploaded. Public
example GETs are explicit user actions. No external scripts/fonts/analytics,
local storage, IndexedDB, service worker or wallet-key entry.

Limits: 8 actions, 256 KiB input, 16,384 policy characters, 128 MiB maximum WASM
linear memory, 15-second worker deadline, 15-second shared WASM fetch+compile
deadline, 4 MiB streamed WASM asset cap, 10-second example loading deadline.
All workers terminate on result, error, cancellation or timeout. Failed loads
provide useful retry; late results are ignored. Compilation itself cannot be
forcibly interrupted, even though its result/deadline is bounded.

The upstream parser may allocate before action count is known. JS/browser-wide
overhead is not bounded by the WASM maximum. Untrusted values use `textContent`,
not HTML interpolation. Clear removes app-held input/report data, not a physical
browser-memory erasure guarantee. PCZTs may carry privacy-sensitive viewing keys
and randomness; this pre-release app remains intended for synthetic data.

CSP permits only same-origin app assets/connections and denies objects, inline
scripts and forms. Worker response CSP denies all connections. Static hosts must
preserve headers; HTML meta CSP is only a fallback. Browser extensions, delivered
page/WASM integrity, browser vulnerabilities and policy provenance remain trust
boundaries. No claim of protection from a compromised static host.

## Pinned provenance and original gate

- librustzcash: `eb38d7a373661179dbc083a2fd58b3a6c9b25818`.
- `orchard = 0.16.0`, `zcash_note_encryption = 0.5.1`; isolated locked dependencies.
- Cached devtool context: `0b3436bb8d235c67cd36b800cb45a7b1b489c415`, read for
  source/lock context, not built in full or used for wallet fixtures.
- `pczt/src/lib.rs:100–120,445`: parsing does not imply semantic validity.
- `pczt/src/roles/verifier/orchard.rs:40–65`: typed parsing plus caller closure,
  not automatic proof/authorization verification.
- `orchard-0.16.0/src/pczt/verify.rs:26,55,103,140,167`: cross-address, cv,
  nullifier, rk, output commitment checks.
- `pczt/src/orchard.rs:273–350,353–460`: compact memo/upstream recovery pattern.
  This app adds glue, not note encryption or curve arithmetic.
- `orchard-0.16.0/src/builder.rs:739,1169`: unsigned PCZT building.
- Existing Airlock evidence `docs/stage0b_changes.diff:2422–2851`, notably
  2586–2589: trusted wallet-key checks, OVK/IVK classification, chain-tip expiry
  bounds and policy gate behavior.

Unlike the gate, Inspector has no trusted wallet FVK/IVK/OVK, chain tip or
authorization state. Consistency is not the gate's approval authority.

## Changed-file map

This focused usability pass changes only `web/index.html`, `web/style.css`,
`web/app.js`, `web/view.js`, `web/memo.js`, `web/policy.js`,
`inspector.test.mjs`, `browser-test.mjs`, `README.md`, generated
`deployment-manifest.json`, `evidence.json` and the ignored allowlisted `dist/`
copies/screenshots. The cube and mark assets are byte-identical; no new static
asset, page, dependency, runtime request or deployment entry was added.

All changes are under this experiment:

- `web/index.html`, `web/style.css`, `web/assets/*.svg`: focused workflow and
  adapted original design/artwork.
- `web/app.js`, `web/form.js`, `web/view.js`: workflow, strict form, separate
  policy/coverage results and safe technical rendering.
- `web/engine.js`, `web/memo.js`, `web/policy.js`: async limits/races, exact memo
  editing, comparison/coverage. Existing `web/worker.js` and its limits retained.
- `src/lib.rs`, `fixtures/src/main.rs`: evidence classification/source fixes,
  Rust tests and two additional coverage fixtures.
- `build.mjs`, `static-assets.mjs`, `deployment-manifest.json`, `serve.mjs`:
  minimal static build/inventory, headers and preview.
- `inspector.test.mjs`, `browser-test.mjs`, `evidence.json`: regression results,
  real-browser evidence and screenshots.
- `package.json`, `.gitignore`, `README.md`: dependency-free commands, output
  isolation and documentation. Existing Cargo pins preserved.

## License review and redistribution

The repository-wide [MIT license](../../LICENSE) applies to original Inspector
code, documentation and original/adapted assets, including
Copyright (c) 2026 Stephen Gabriel. The pre-existing contributor and
[starter/SVG MIT notice](../../apps/web/LICENSE) are retained in `web/LICENSE.txt`.
Third-party compiled code is not relicensed as our original MIT work.

`web/THIRD_PARTY_LICENSES.txt` includes per-version license expressions and actual
upstream notice texts, plus Rust 1.99.1's library copyright inventory. BSD-3-Clause
and Unicode terms remain additional requirements where applicable. Both files
are explicitly allowlisted, served as plain text, copied into dist and included
in the deployment hashes. No license text is fetched at runtime.

The review used this cached metadata command from the experiment:

```sh
cargo metadata --offline --locked --filter-platform wasm32-unknown-unknown --format-version 1
```

Walk `resolve.root`/`resolve.nodes` and inspect the reachable packages' declared
licenses and their actual `LICENSE*`, `COPYING*`, `NOTICE*` and copyright files.
The 107-package graph conservatively includes optional/host build/proc-macro
dependencies, not just code linked into the browser binary. For the four packaged
crates without license texts, the exact upstream revision in `.cargo_vcs_info.json`
was used; source URLs are recorded in the bundled text. Workspace-root Zcash
licenses and the installed Rust `share/doc/rust/COPYRIGHT-library.html` were
also retained. Identical texts are consolidated with attribution mappings.

This review does not add or upgrade dependencies. Changes to Cargo pins/features
or Rust toolchain require a fresh license review and updated notices; the packager
copies committed notice text rather than auditing dependencies itself.
See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for license choices and
preserved historical upstream notices.

**Owner-reported manual test:** all three examples and Clear worked on a physical
Android phone over mobile data. This is not independent automation evidence.
