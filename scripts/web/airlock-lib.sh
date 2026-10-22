#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${AIRLOCK_REPO_DIR:-$(cd "$LIB_DIR/../.." && pwd)}"
APP_DIR="$REPO_DIR/apps/api"
WEB_DIR="$REPO_DIR/apps/web"
WEB_SCRIPT_DIR="$REPO_DIR/scripts/web"

DEVTOOL_BIN="${AIRLOCK_DEVTOOL_BIN:-$HOME/airlock-build/zcash-devtool/target/release/zcash-devtool}"
WALLET_ROOT="${AIRLOCK_WALLET_ROOT:-$HOME/airlock-state}"
SENDER_WALLET="${AIRLOCK_SENDER_WALLET:-$WALLET_ROOT/sender}"
RECIPIENT_WALLET="${AIRLOCK_RECIPIENT_WALLET:-$WALLET_ROOT/recipient}"
IDENTITY_FILE="${AIRLOCK_IDENTITY_FILE:-$WALLET_ROOT/sender-age.txt}"
RECIPIENT_UA_FILE="${AIRLOCK_RECIPIENT_UA_FILE:-$WALLET_ROOT/recipient.ua}"
SENDER_UA_FILE="${AIRLOCK_SENDER_UA_FILE:-$WALLET_ROOT/sender.ua}"
ALT_RECIPIENT_UA_FILE="${AIRLOCK_ALT_RECIPIENT_UA_FILE:-$WALLET_ROOT/alt-recipient.ua}"
GATE_HOME="${AIRLOCK_GATE_HOME:-$HOME/.airlock-gate}"

RUN_DIR="${AIRLOCK_RUN_DIR:-$HOME/airlock-run}"
GATE_SOCKET_DIR="$RUN_DIR/gate"
WORKER_SOCKET_DIR="$RUN_DIR/worker"
GATE_SOCKET="$GATE_SOCKET_DIR/gate.sock"
WORKER_SOCKET="$WORKER_SOCKET_DIR/worker.sock"

WORKER_STATE="${AIRLOCK_WORKER_STATE:-$HOME/airlock-worker}"
WORKER_CONFIG="$WORKER_STATE/config.json"
WORKER_SPOOL="${AIRLOCK_WORKER_SPOOL:-$HOME/airlock-worker-spool}"
API_STATE="${AIRLOCK_API_STATE:-$HOME/airlock-api-state}"
LOG_DIR="${AIRLOCK_LOG_DIR:-$HOME/airlock-logs}"
INVENTORY_FILE="$API_STATE/inventory.json"

API_HOST="${AIRLOCK_API_HOST:-127.0.0.1}"
API_PORT="${AIRLOCK_API_PORT:-8787}"
API_ORIGIN="${AIRLOCK_PUBLIC_ORIGIN:-http://127.0.0.1:$API_PORT}"
API_COOKIE_SECURE="${AIRLOCK_COOKIE_SECURE:-0}"

NODE_BIN="${AIRLOCK_NODE_BIN:-/usr/bin/node}"
BWRAP_BIN="${AIRLOCK_BWRAP_BIN:-/usr/bin/bwrap}"
if [ -e /mnt/wsl/resolv.conf ]; then
  RESOLV_BIND=(--dir /mnt --dir /mnt/wsl --ro-bind /mnt/wsl/resolv.conf /mnt/wsl/resolv.conf)
else
  RESOLV_BIND=(--ro-bind /etc/resolv.conf /etc/resolv.conf)
fi
RUNTIME_USER="${AIRLOCK_RUNTIME_USER:-${USER:-airlock}}"

SET_ID="${AIRLOCK_SET_ID:-set-m1a}"
MATCH_ID="${AIRLOCK_MATCH_ID:-m1a-match}"
RECIPIENT_ID="${AIRLOCK_RECIPIENT_ID:-m1a-recipient}"
MEMO_ID="${AIRLOCK_MEMO_ID:-m1a-memo}"
APPROVAL_AMOUNT="100000"
APPROVAL_MAX_FEE="${AIRLOCK_APPROVAL_MAX_FEE:-10000}"
APPROVAL_MEMO="Airlock live demo"
APPROVAL_EXPIRES_IN="${AIRLOCK_APPROVAL_EXPIRES_IN:-604800}"

BWRAP_BASE=(
  --ro-bind /usr /usr
  --ro-bind /lib /lib
  --ro-bind /lib64 /lib64
  --ro-bind /etc /etc
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --dir /run
  --dir /run/airlock
  "${RESOLV_BIND[@]}"
  --unshare-ipc
  --unshare-pid
  --unshare-uts
  --hostname airlock
  --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin
  --setenv HOME /tmp
  --setenv USER "$RUNTIME_USER"
  --setenv LOGNAME "$RUNTIME_USER"
  --setenv TMPDIR /tmp
  --setenv LANG C.UTF-8
  --setenv LC_ALL C.UTF-8
  --setenv TZ UTC
  --setenv NO_COLOR 1
  --setenv RUST_BACKTRACE 0
  --chdir /tmp
  --die-with-parent
)

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

need_file() {
  [ -f "$1" ] || die "missing file: $1"
}

need_exec() {
  [ -x "$1" ] || die "missing executable: $1"
}

ensure_dirs() {
  mkdir -p "$RUN_DIR" "$GATE_SOCKET_DIR" "$WORKER_SOCKET_DIR"
  mkdir -p "$WORKER_STATE" "$WORKER_SPOOL" "$API_STATE" "$LOG_DIR"
  chmod 700 "$RUN_DIR" "$GATE_SOCKET_DIR" "$WORKER_SOCKET_DIR"
  chmod 700 "$WORKER_STATE" "$WORKER_SPOOL" "$API_STATE" "$LOG_DIR"
}

check_host_inputs() {
  need_exec "$BWRAP_BIN"
  need_exec "$NODE_BIN"
  need_exec "$DEVTOOL_BIN"
  need_file "$IDENTITY_FILE"
  need_file "$RECIPIENT_UA_FILE"
  need_file "$SENDER_UA_FILE"
  [ -d "$SENDER_WALLET" ] || die "missing sender wallet: $SENDER_WALLET"
  [ -d "$RECIPIENT_WALLET" ] || die "missing recipient wallet: $RECIPIENT_WALLET"
  [ -d "$GATE_HOME" ] || die "missing gate home: $GATE_HOME"
}

pid_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_for_socket() {
  local path="$1" label="$2" tries="${3:-150}"
  local i
  for ((i = 0; i < tries; i += 1)); do
    if [ -S "$path" ]; then
      return 0
    fi
    sleep 0.1
  done
  log "ERROR: $label socket did not appear: $path" >&2
  return 1
}

wait_for_http() {
  local url="$1" tries="${2:-200}"
  local i
  for ((i = 0; i < tries; i += 1)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  log "ERROR: API did not answer: $url" >&2
  return 1
}
