#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

check_host_inputs
ensure_dirs
command -v curl >/dev/null 2>&1 || die "curl is required"
[ -f "$INVENTORY_FILE" ] || die "missing inventory; run provision-demo-clean.sh first"
[ -f "$WORKER_CONFIG" ] || die "missing worker config; run provision-demo-clean.sh first"

start_component() {
  local name="$1"
  local script="$2"
  local pid_file="$RUN_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  if pid_running "$pid_file"; then
    log "$name already running (pid $(cat "$pid_file"))"
    return 0
  fi
  : >"$log_file"
  log "starting $name; log: $log_file"
  nohup setsid "$script" >>"$log_file" 2>&1 &
  printf '%s\n' "$!" >"$pid_file"
}

tail_log() {
  local name="$1"
  log "last lines from $name.log:"
  tail -n 40 "$LOG_DIR/$name.log" >&2 || true
}

start_component gate "$WEB_SCRIPT_DIR/run-gate.sh"
if ! wait_for_socket "$GATE_SOCKET" "gate" 200; then
  tail_log gate
  exit 1
fi

start_component worker "$WEB_SCRIPT_DIR/run-worker.sh"
if ! wait_for_socket "$WORKER_SOCKET" "worker" 200; then
  tail_log worker
  exit 1
fi

start_component api "$WEB_SCRIPT_DIR/run-api.sh"
if ! wait_for_http "http://127.0.0.1:$API_PORT/api/health" 300; then
  tail_log api
  exit 1
fi

log "all services are up"
log "local URL: http://127.0.0.1:$API_PORT/"
curl -fsS "http://127.0.0.1:$API_PORT/api/health"
printf '\n'
