#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${AIRLOCK_BUILD_DIR:-$HOME/airlock-build}"
DEVTOOL_DIR="${AIRLOCK_DEVTOOL_DIR:-$WORK_DIR/zcash-devtool}"
UPSTREAM_URL="https://github.com/zcash/zcash-devtool.git"
UPSTREAM_PIN="0b3436bb8d235c67cd36b800cb45a7b1b489c415"
PATCH="$ROOT_DIR/docs/stage0b_changes.diff"
EXPECTED_SHA256="9a87f3daec59640011da655c53b6fbcc25ed0eb37631ac439a46efc1ea137f6a"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need git
need cargo
[ -f "$PATCH" ] || {
  printf 'missing patch: %s\n' "$PATCH" >&2
  exit 1
}

mkdir -p "$WORK_DIR"

if [ ! -d "$DEVTOOL_DIR/.git" ]; then
  git clone "$UPSTREAM_URL" "$DEVTOOL_DIR"
fi

if [ -n "$(git -C "$DEVTOOL_DIR" status --porcelain)" ]; then
  if git -C "$DEVTOOL_DIR" apply --reverse --check "$PATCH"; then
    printf 'patch already applied in %s\n' "$DEVTOOL_DIR"
  else
    printf 'refusing to modify a dirty checkout: %s\n' "$DEVTOOL_DIR" >&2
    exit 1
  fi
else
  if ! git -C "$DEVTOOL_DIR" cat-file -e "$UPSTREAM_PIN^{commit}" 2>/dev/null; then
    git -C "$DEVTOOL_DIR" fetch --quiet origin "$UPSTREAM_PIN"
  fi
  git -C "$DEVTOOL_DIR" checkout --quiet --detach "$UPSTREAM_PIN"
  actual_pin="$(git -C "$DEVTOOL_DIR" rev-parse HEAD)"
  [ "$actual_pin" = "$UPSTREAM_PIN" ] || {
    printf 'unexpected upstream revision: %s\n' "$actual_pin" >&2
    exit 1
  }
  git -C "$DEVTOOL_DIR" apply --check "$PATCH"
  git -C "$DEVTOOL_DIR" apply "$PATCH"
fi

cargo build --release --locked --manifest-path "$DEVTOOL_DIR/Cargo.toml"

BINARY="$DEVTOOL_DIR/target/release/zcash-devtool"
[ -x "$BINARY" ] || {
  printf 'build did not produce %s\n' "$BINARY" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
fi

printf 'binary: %s\n' "$BINARY"
printf 'sha256: %s\n' "$ACTUAL_SHA256"
printf 'tested: %s\n' "$EXPECTED_SHA256"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  printf 'warning: rebuilt binary hash differs from the evidence build\n' >&2
fi

if [ -n "${AIRLOCK_REQUIRE_EXACT_GATE_SHA256:-}" ] && [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  printf 'binary hash mismatch and exact-hash mode is enabled\n' >&2
  exit 1
fi
