#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

ensure_dirs
need_exec "$BWRAP_BIN"
need_exec "$NODE_BIN"
need_file "$APP_DIR/package.json"
[ -d "$APP_DIR/dist" ] || die "missing built API dist: $APP_DIR/dist"
[ -d "$WEB_DIR" ] || die "missing web directory: $WEB_DIR"
[ -S "$WORKER_SOCKET" ] || die "worker socket is not present: $WORKER_SOCKET"

log "starting API under bwrap (no wallet, no gate home, worker socket only)"

"$BWRAP_BIN" "${BWRAP_BASE[@]}" \
  --dir /srv \
  --dir /srv/api \
  --ro-bind "$APP_DIR/dist" /srv/api/dist \
  --ro-bind "$APP_DIR/package.json" /srv/api/package.json \
  --dir /srv/web \
  --ro-bind "$WEB_DIR" /srv/web \
  --dir /state \
  --bind "$API_STATE" /state \
  --dir /run/airlock/worker \
  --ro-bind "$WORKER_SOCKET_DIR" /run/airlock/worker \
  --setenv AIRLOCK_API_HOST "$API_HOST" \
  --setenv AIRLOCK_API_PORT "$API_PORT" \
  --setenv AIRLOCK_WEB_DIR /srv/web \
  --setenv AIRLOCK_API_STATE /state \
  --setenv AIRLOCK_WORKER_SOCKET /run/airlock/worker/worker.sock \
  --setenv AIRLOCK_PUBLIC_ORIGIN "$API_ORIGIN" \
  --setenv AIRLOCK_COOKIE_SECURE "$API_COOKIE_SECURE" \
  --setenv AIRLOCK_SESSION_TTL_SECONDS 604800 \
  --setenv AIRLOCK_PER_IP_SESSION_LIMIT 20 \
  --setenv AIRLOCK_GLOBAL_SESSION_LIMIT 200 \
  --setenv AIRLOCK_REQUEST_BODY_LIMIT 16384 \
  -- /usr/bin/node /srv/api/dist/apps/api/src/main.js &
child="$!"

cleanup() {
  if kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/api.pid"
}
trap 'cleanup; exit 143' TERM INT

wait "$child"
