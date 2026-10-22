#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

check_host_inputs
ensure_dirs
need_file "$WORKER_CONFIG"
need_file "$APP_DIR/package.json"
[ -d "$APP_DIR/dist" ] || die "missing built API dist: $APP_DIR/dist"
[ -S "$GATE_SOCKET" ] || die "gate socket is not present: $GATE_SOCKET"

rm -f "$WORKER_SOCKET"
log "starting trusted worker under bwrap (wallet read-write, gate home not mounted)"

"$BWRAP_BIN" "${BWRAP_BASE[@]}" \
  --dir /wallet \
  --bind "$WALLET_ROOT" /wallet \
  --dir /config \
  --ro-bind "$WORKER_STATE" /config \
  --dir /spool \
  --bind "$WORKER_SPOOL" /spool \
  --dir /run/airlock/gate \
  --ro-bind "$GATE_SOCKET_DIR" /run/airlock/gate \
  --dir /run/airlock/worker \
  --bind "$WORKER_SOCKET_DIR" /run/airlock/worker \
  --dir /srv \
  --dir /srv/api \
  --ro-bind "$APP_DIR/dist" /srv/api/dist \
  --ro-bind "$APP_DIR/package.json" /srv/api/package.json \
  --dir /opt \
  --dir /opt/airlock \
  --ro-bind "$DEVTOOL_BIN" /opt/airlock/zcash-devtool \
  --setenv AIRLOCK_WORKER_SOCKET /run/airlock/worker/worker.sock \
  --setenv AIRLOCK_SPOOL_DIR /spool \
  --setenv AIRLOCK_WORKER_CONFIG /config/config.json \
  --setenv AIRLOCK_GATE_SOCKET /run/airlock/gate/gate.sock \
  --setenv AIRLOCK_GATE_HOME /gate-home \
  --setenv AIRLOCK_WALLET_DIR /wallet/sender \
  --setenv AIRLOCK_IDENTITY /wallet/sender-age.txt \
  --setenv AIRLOCK_RECIPIENT_WALLET /wallet/recipient \
  --setenv AIRLOCK_DEVTOOL_BIN /opt/airlock/zcash-devtool \
  --setenv AIRLOCK_SYNC_INTERVAL_SECONDS 300 \
  --setenv AIRLOCK_MAX_JOB_SECONDS 240 \
  -- /usr/bin/node /srv/api/dist/apps/api/src/worker.js &
child="$!"

cleanup() {
  if kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -f "$WORKER_SOCKET" "$RUN_DIR/worker.pid"
}
trap 'cleanup; exit 143' TERM INT

wait "$child"
