#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

stop_component() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"
  if ! pid_running "$pid_file"; then
    log "$name is not running"
    rm -f "$pid_file"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  log "stopping $name (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for ((i = 0; i < 100; i += 1)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
      return 0
    fi
    sleep 0.1
  done
  log "forcing $name (pid $pid)"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

stop_component api
stop_component worker
stop_component gate
rm -f "$WORKER_SOCKET" "$GATE_SOCKET"
log "stopped"
