# Gate source snapshot

This directory preserves the reviewed Airlock gate source snapshot and the two probe
examples included in the complete patch.

- The authoritative reproduction source is
  [`../stage0b_changes.diff`](../stage0b_changes.diff), applied to `zcash-devtool` commit
  `0b3436bb8d235c67cd36b800cb45a7b1b489c415`.
- Build and verification instructions are in
  [`../upstream/zcash-devtool/README.md`](../upstream/zcash-devtool/README.md).
- `src/` contains the current gate module files: `approval.rs`, `fixture.rs`, `mod.rs`, and
  `validate.rs`. The snapshot is for review; the patch is authoritative.
- `examples/` contains the probe examples included in the patch.
- Historical Stage 0B/repair logs, raw PCZTs, approval records, wallet files, and local
  build output are not part of this release.
- No wallet seed, identity file, gate MAC key, approval record, session, or raw PCZT is in
  this directory.
- Source comments in the snapshot and patch refer to the historical internal Stage 0B repair
  report; that report is intentionally excluded from this release. The patch and the
  architecture notes are the retained technical record.
