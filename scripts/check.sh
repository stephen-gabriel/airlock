#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"

if [ ! -d "$API_DIR/node_modules" ]; then
  printf 'install API dependencies first: (cd apps/api && npm ci)\n' >&2
  exit 1
fi

node --check "$ROOT_DIR/apps/web/app-live.js"
node --check "$ROOT_DIR/tests/m3-fixtures/fixtures.mjs"
node --check "$ROOT_DIR/tests/m3-fixtures/server.mjs"
node --check "$ROOT_DIR/tests/m3-fixtures/run.mjs"
bash -n "$ROOT_DIR"/scripts/*.sh "$ROOT_DIR"/scripts/web/*.sh

cd "$API_DIR"
npm run typecheck
npm run build
npm run test:m2
