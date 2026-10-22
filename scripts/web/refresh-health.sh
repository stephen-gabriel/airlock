#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

need_exec "$NODE_BIN"
[ -S "$WORKER_SOCKET" ] || die "worker socket is not present: $WORKER_SOCKET"
exec "$NODE_BIN" "$WEB_SCRIPT_DIR/refresh-health.mjs" "$WORKER_SOCKET"
