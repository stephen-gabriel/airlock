#!/usr/bin/env bash
# Proposer/operator boundary test.
# The operator runs the gate daemon; the proposer runs inside an unprivileged
# user+mount namespace that hides the operator home (simulating the separate-UID
# deployment). Nothing is broadcast.
set -uo pipefail

DT="${AIRLOCK_DEVTOOL_BIN:-$HOME/airlock-build/zcash-devtool/target/release/zcash-devtool}"
STATE="${AIRLOCK_WALLET_ROOT:-$HOME/airlock-state}"
SENDER="${AIRLOCK_SENDER_WALLET:-$STATE/sender}"
IDENTITY="${AIRLOCK_IDENTITY_FILE:-$STATE/sender-age.txt}"
RECIP_FILE="${AIRLOCK_RECIPIENT_UA_FILE:-$STATE/recipient.ua}"
OPERATOR_HOME="${AIRLOCK_OPERATOR_HOME:-$(dirname "$STATE")}"
TEST_ROOT="${AIRLOCK_GATE_TEST_DIR:-${TMPDIR:-/tmp}/airlock-gate-tests}"
D="$TEST_ROOT/boundary"
H="$D/home"
SOCK="$D/sock/gate.sock"
BIN="$D/bin/airlock-gate"
RES="$D/boundary_results.txt"

[ -x "$DT" ] || { echo "missing patched devtool: $DT" >&2; exit 1; }
[ -d "$SENDER" ] || { echo "missing sender wallet: $SENDER" >&2; exit 1; }
[ -f "$IDENTITY" ] || { echo "missing identity: $IDENTITY" >&2; exit 1; }
[ -f "$RECIP_FILE" ] || { echo "missing recipient UA: $RECIP_FILE" >&2; exit 1; }
RECIP=$(cat "$RECIP_FILE")

rm -rf "$D"
mkdir -p "$D/bin" "$D/sock" "$H"
cp "$DT" "$BIN"
chmod 755 "$BIN"
: > "$RES"

pass=0
fail=0
say() { echo "$@" | tee -a "$RES"; }

expect() {
  local name=$1 pat=$2
  shift 2
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  say "=== $name"
  say "$out"
  say "--- RC=$rc"
  if echo "$out" | grep -qE "$pat"; then
    say "PASS $name"
    pass=$((pass + 1))
  else
    say "FAIL $name (want /$pat/)"
    fail=$((fail + 1))
  fi
}

# Proposer sandbox: new user+mount namespaces; the operator home is replaced by
# an empty tmpfs, so operator secrets and gate state are unreachable.
sandbox() {
  unshare -Urm bash -c 'mount -t tmpfs none "$1" && shift && exec "$@"' \
    _ "$OPERATOR_HOME" "$@"
}

say "== proposals (create + prove)"
"$DT" pczt -w "$SENDER" create --address "$RECIP" --value 1000000 \
  --memo "Airlock repair demo" --output "$D/demo.bin" >"$D/create.log" 2>&1
say "create_rc=$?"
"$DT" pczt -w "$SENDER" prove -i "$IDENTITY" "$D/demo.bin" \
  --output "$D/demo.proven" >>"$D/create.log" 2>&1
say "prove_rc=$?"
chmod 644 "$D/demo.proven"
"$DT" pczt -w "$SENDER" create --address "$RECIP" --value 1000000 \
  --memo "Airlock boundary other" --output "$D/other.bin" >>"$D/create.log" 2>&1
say "other_create_rc=$?"
"$DT" pczt -w "$SENDER" prove -i "$IDENTITY" "$D/other.bin" \
  --output "$D/other.proven" >>"$D/create.log" 2>&1
say "other_prove_rc=$?"
chmod 644 "$D/other.proven"

say "== operator approval"
expect operator_approve 'APPROVED' "$DT" airlock-gate approve --gate-home "$H" \
  --recipient "$RECIP" --amount 1000000 --max-fee 10000 \
  --memo-policy 'exact:Airlock repair demo' --id d1 --expires-in 3600

say "== operator daemon"
nohup "$DT" airlock-gate serve --gate-home "$H" --wallet "$SENDER" \
  --identity "$IDENTITY" --socket "$SOCK" >"$D/serve.log" 2>&1 &
serve_pid=$!
for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && break
  sleep 0.2
done
say "socket=$(stat -c '%F %a' "$SOCK" 2>/dev/null)"
say "daemon_pid=$serve_pid"
head -1 "$D/serve.log" | tee -a "$RES"

say "== proposer interface surface"
"$DT" airlock-gate submit --help | tee -a "$RES"

expect proposer_submit_ok 'SIGN_OK' sandbox "$BIN" airlock-gate submit \
  --socket "$SOCK" --approval-id d1 --proposal "$D/demo.proven" --output "$D/out.signed"
say "artifact bytes=$(stat -c '%s' "$D/out.signed" 2>/dev/null) mode=$(stat -c '%a' "$D/out.signed" 2>/dev/null)"

expect proposer_retry_recovered 'SIGN_RECOVERED_OK' sandbox "$BIN" airlock-gate submit \
  --socket "$SOCK" --approval-id d1 --proposal "$D/demo.proven" --output "$D/out2.signed"

expect proposer_other_tx_rejected 'E_AUTH_CONSUMED' sandbox "$BIN" airlock-gate submit \
  --socket "$SOCK" --approval-id d1 --proposal "$D/other.proven" \
  --output "$D/other.signed"

say "== proposer cannot read operator state (inside sandbox)"
expect sandbox_cannot_read_keys 'No such file|Permission denied' \
  sandbox bash -c 'cat "$1"' _ "$SENDER/keys.toml"
expect sandbox_cannot_read_gate_home 'No such file|Permission denied' \
  sandbox bash -c 'ls "$1"' _ "$OPERATOR_HOME/.airlock-gate"
expect sandbox_cannot_sign_locally 'No such file|Permission denied|E_AUTH_NO_APPROVAL|E_STATE_CORRUPT' \
  sandbox "$BIN" airlock-gate sign --gate-home "$OPERATOR_HOME/.airlock-gate" \
  --wallet "$SENDER" \
  --identity "$IDENTITY" \
  --proposal "$D/demo.proven" --approval-id d1 --output "$D/local.signed"

say "== proposer cannot create a real approval"
expect sandbox_forges_local_approval 'APPROVED' sandbox "$BIN" airlock-gate approve \
  --gate-home "$OPERATOR_HOME/.airlock-gate" --recipient "$RECIP" --amount 1000000 \
  --max-fee 10000 --memo-policy 'exact:Airlock repair demo' --id forged
expect forged_approval_rejected 'E_AUTH_NO_APPROVAL' sandbox "$BIN" airlock-gate submit \
  --socket "$SOCK" --approval-id forged --proposal "$D/demo.proven" --output "$D/forged.signed"

say "== operator store unchanged"
say "$(ls -1 "$H/approvals")"
say "$("$DT" airlock-gate approvals --gate-home "$H" list)"

kill "$serve_pid" 2>/dev/null
wait "$serve_pid" 2>/dev/null

say ""
say "SUMMARY pass=$pass fail=$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
