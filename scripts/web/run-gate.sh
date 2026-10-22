#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

check_host_inputs
ensure_dirs
[ -d "$GATE_HOME" ] || die "missing gate home: $GATE_HOME"
[ -d "$SENDER_WALLET" ] || die "missing sender wallet: $SENDER_WALLET"

rm -f "$GATE_SOCKET"
log "starting gate under bwrap (network namespace, protected state mounted read-write)"

"$BWRAP_BIN" "${BWRAP_BASE[@]}" \
  --unshare-net \
  --dir /wallet \
  --ro-bind "$WALLET_ROOT" /wallet \
  --dir /gate-home \
  --bind "$GATE_HOME" /gate-home \
  --dir /opt \
  --dir /opt/airlock \
  --ro-bind "$DEVTOOL_BIN" /opt/airlock/zcash-devtool \
  --dir /run/airlock/gate \
  --bind "$GATE_SOCKET_DIR" /run/airlock/gate \
  -- /opt/airlock/zcash-devtool airlock-gate serve \
  --gate-home /gate-home \
  --wallet /wallet/sender \
  --identity /wallet/sender-age.txt \
  --socket /run/airlock/gate/gate.sock &
child="$!"

cleanup() {
  if kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -f "$GATE_SOCKET" "$RUN_DIR/gate.pid"
}
trap 'cleanup; exit 143' TERM INT

wait "$child"
