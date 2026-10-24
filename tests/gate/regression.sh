#!/usr/bin/env bash
# Gate regression tests. No broadcast.
# Covers exact memo bytes, path/ID handling, atomic state + recovery,
# concurrency, and expiry/tip handling.
set -uo pipefail

DT="${AIRLOCK_DEVTOOL_BIN:-$HOME/airlock-build/zcash-devtool/target/release/zcash-devtool}"
STATE="${AIRLOCK_WALLET_ROOT:-$HOME/airlock-state}"
SENDER="${AIRLOCK_SENDER_WALLET:-$STATE/sender}"
IDENTITY="${AIRLOCK_IDENTITY_FILE:-$STATE/sender-age.txt}"
RECIP_FILE="${AIRLOCK_RECIPIENT_UA_FILE:-$STATE/recipient.ua}"
TEST_ROOT="${AIRLOCK_GATE_TEST_DIR:-${TMPDIR:-/tmp}/airlock-gate-tests}"
H="$TEST_ROOT/regression/home"
W="$TEST_ROOT/regression/work"
RES="$W/results.txt"

[ -x "$DT" ] || { echo "missing patched devtool: $DT" >&2; exit 1; }
[ -d "$SENDER" ] || { echo "missing sender wallet: $SENDER" >&2; exit 1; }
[ -f "$IDENTITY" ] || { echo "missing identity: $IDENTITY" >&2; exit 1; }
[ -f "$RECIP_FILE" ] || { echo "missing recipient UA: $RECIP_FILE" >&2; exit 1; }
RECIP=$(cat "$RECIP_FILE")

export AIRLOCK_GATE_TEST_FIXTURES=1

rm -rf "$H" "$W"
mkdir -p "$W" "$H"
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

approve() {
  local id=$1 policy=$2 expires=${3:-3600} amount=${4:-1000000}
  "$DT" airlock-gate approve --gate-home "$H" --recipient "$RECIP" \
    --amount "$amount" --max-fee 10000 --memo-policy "$policy" \
    --id "$id" --expires-in "$expires"
}

gval() {
  "$DT" airlock-gate validate --gate-home "$H" --wallet "$SENDER" \
    --identity "$IDENTITY" --proposal "$1" --approval-id "$2"
}

gsign() {
  "$DT" airlock-gate sign --gate-home "$H" --wallet "$SENDER" \
    --identity "$IDENTITY" --proposal "$1" --approval-id "$2" --output "$3"
}

list_line() { "$DT" airlock-gate approvals --gate-home "$H" list 2>&1 | grep -E "^$1 "; }

make_proven() {
  local out=$1
  shift
  "$DT" pczt -w "$SENDER" create --address "$RECIP" --value 1000000 \
    --output "$W/$out.bin" "$@" >"$W/$out.create.log" 2>&1
  local rc1=$?
  "$DT" pczt -w "$SENDER" prove -i "$IDENTITY" "$W/$out.bin" \
    --output "$W/$out.proven" >>"$W/$out.create.log" 2>&1
  local rc2=$?
  say "proposal $out create_rc=$rc1 prove_rc=$rc2"
}

say "== gate init"
"$DT" airlock-gate approvals --gate-home "$H" list >/dev/null 2>&1
say "gate_home=$H mac_key=$(stat -c '%a' "$H/mac.key")"

say "== proposals (create + prove)"
make_proven hidden --memo-hex 4169726c6f636b004556494c
make_proven prefix --memo-hex f44169726c6f636b
make_proven valid --memo-hex 4169726c6f636b
make_proven resume --memo "Airlock resume"
EMPTY_HEX=$(python3 -c 'print("f6" + "00" * 511)')
ZERO_HEX=$(python3 -c 'print("00" * 512)')
make_proven emptym --memo-hex "$EMPTY_HEX"
make_proven zeromemo --memo-hex "$ZERO_HEX"

# ---------------- exact memo enforcement ----------------
approve m_hidden 'exact:Airlock' >/dev/null
expect memo_hidden_after_nul 'E_POLICY_MEMO' gval "$W/hidden.proven" m_hidden

approve m_prefix 'exact:Airlock' >/dev/null
expect memo_unexpected_prefix 'E_POLICY_MEMO' gval "$W/prefix.proven" m_prefix

approve m_valid 'exact:Airlock' >/dev/null
expect memo_valid_exact 'VALIDATE_OK' gval "$W/valid.proven" m_valid
out=$(gsign "$W/valid.proven" m_valid "$W/m_valid.signed" 2>&1)
say "=== memo_valid_sign"
say "$out"
if echo "$out" | grep -q 'SIGN_OK'; then
  say "PASS memo_valid_sign"
  pass=$((pass + 1))
else
  say "FAIL memo_valid_sign"
  fail=$((fail + 1))
fi
TXID1=$(echo "$out" | grep -oE 'txid=[0-9a-f]{64}' | head -1 | cut -d= -f2)
say "TXID1=$TXID1"

approve m_empty 'empty' >/dev/null
expect memo_empty_canonical 'VALIDATE_OK' gval "$W/emptym.proven" m_empty

approve m_zero 'empty' >/dev/null
expect memo_empty_rejects_all_zero 'E_POLICY_MEMO' gval "$W/zeromemo.proven" m_zero

expect memo_reject_empty_text 'E_MEMO_UNSUPPORTED' approve m_textbad 'exact:'
LONG_TEXT=$(python3 -c 'print("A" * 513)')
expect memo_reject_overlong 'E_MEMO_UNSUPPORTED' approve m_textlong "exact:$LONG_TEXT"

# ---------------- path / ID handling ----------------
expect id_reject_traversal 'E_PATH_UNSAFE' approve '../evil' empty
expect id_reject_slash 'E_PATH_UNSAFE' approve 'a/b' empty
LONG_ID=$(python3 -c 'print("a" * 65)')
expect id_reject_overlong 'E_PATH_UNSAFE' approve "$LONG_ID" empty

approve dup1 'empty' >/dev/null
expect dup_approve_rejected 'E_AUTH_EXISTS' approve dup1 'empty'

approve p1 'exact:Airlock' >/dev/null
ln -sfn "$W/valid.proven" "$W/out.link"
expect output_reject_symlink 'E_PATH_UNSAFE' gsign "$W/valid.proven" p1 "$W/out.link"
say "state after rejected output: $(list_line p1)"
if list_line p1 | grep -q 'status=Pending'; then
  say "PASS output_rejection_did_not_consume"
  pass=$((pass + 1))
else
  say "FAIL output_rejection_did_not_consume"
  fail=$((fail + 1))
fi

# ---------------- atomic state + recovery ----------------
approve r1 'exact:Airlock resume' >/dev/null
expect crash_after_reserve 'CRASH_INJECT' env AIRLOCK_GATE_TEST_CRASH_AFTER=reserve \
  "$DT" airlock-gate sign --gate-home "$H" --wallet "$SENDER" --identity "$IDENTITY" \
  --proposal "$W/resume.proven" --approval-id r1 --output "$W/r1a.signed"
say "state after crash: $(list_line r1)"
if list_line r1 | grep -q 'status=Reserved'; then
  say "PASS reserve_persisted_before_sign"
  pass=$((pass + 1))
else
  say "FAIL reserve_persisted_before_sign"
  fail=$((fail + 1))
fi
expect resume_after_reserve_crash 'SIGN_OK' gsign "$W/resume.proven" r1 "$W/r1b.signed"
TXID3=$(list_line r1 | grep -oE 'bound=Some\("[0-9a-f]{64}"\)' | grep -oE '[0-9a-f]{64}')
say "TXID3=$TXID3"

approve r2 'exact:Airlock resume' >/dev/null
expect crash_after_artifact 'CRASH_INJECT' env AIRLOCK_GATE_TEST_CRASH_AFTER=artifact \
  "$DT" airlock-gate sign --gate-home "$H" --wallet "$SENDER" --identity "$IDENTITY" \
  --proposal "$W/resume.proven" --approval-id r2 --output "$W/r2a.signed"
say "state after artifact crash: $(list_line r2)"
HASH_BEFORE=$(sha256sum "$H/signed/$TXID3.pczt" | cut -d' ' -f1)
out=$(gsign "$W/resume.proven" r2 "$W/r2b.signed" 2>&1)
say "=== reuse_artifact_without_resigning"
say "$out"
HASH_AFTER=$(sha256sum "$H/signed/$TXID3.pczt" | cut -d' ' -f1)
if echo "$out" | grep -q 'SIGN_RECOVERED_OK' && [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then
  say "PASS reuse_artifact_without_resigning"
  pass=$((pass + 1))
else
  say "FAIL reuse_artifact_without_resigning"
  fail=$((fail + 1))
fi

expect same_tx_retry 'SIGN_RECOVERED_OK' gsign "$W/resume.proven" r2 "$W/r2c.signed"
expect different_tx_consumed 'E_AUTH_CONSUMED' gsign "$W/zeromemo.proven" r2 "$W/r2d.signed"

approve r3 'exact:Airlock' >/dev/null
( gsign "$W/valid.proven" r3 "$W/r3a.signed" >"$W/r3a.log" 2>&1 ) &
gpid1=$!
( gsign "$W/zeromemo.proven" r3 "$W/r3b.signed" >"$W/r3b.log" 2>&1 ) &
gpid2=$!
wait "$gpid1" "$gpid2"
# Different transactions may race; the binding check must allow at most one
# success, and a rejection must be a clean authorization error.
OKS=$(cat "$W/r3a.log" "$W/r3b.log" | grep -c 'SIGN_OK')
BAD=$(cat "$W/r3a.log" "$W/r3b.log" | grep -cE 'E_STATE_CORRUPT|E_AUTH_IN_USE|E_AUTH_CONSUMED|E_POLICY_MEMO')
say "=== competing_transactions total_ok=$OKS clean_rejects=$BAD"
cat "$W/r3a.log" "$W/r3b.log" | tee -a "$RES"
if [ "$OKS" -eq 1 ] && [ "$BAD" -eq 1 ]; then
  say "PASS competing_transactions"
  pass=$((pass + 1))
else
  say "FAIL competing_transactions"
  fail=$((fail + 1))
fi

approve r5 'exact:Airlock' >/dev/null
( gsign "$W/valid.proven" r5 "$W/r5a.signed" >"$W/r5a.log" 2>&1 ) &
gpid1=$!
( gsign "$W/valid.proven" r5 "$W/r5b.signed" >"$W/r5b.log" 2>&1 ) &
gpid2=$!
wait "$gpid1" "$gpid2"
OKS=$(cat "$W/r5a.log" "$W/r5b.log" | grep -c 'SIGN_OK')
RETRY=$(cat "$W/r5a.log" "$W/r5b.log" | grep -cE 'SIGN_RECOVERED_OK|E_AUTH_IN_USE')
say "=== concurrent_same_tx ok=$OKS retry_or_busy=$RETRY"
cat "$W/r5a.log" "$W/r5b.log" | tee -a "$RES"
if [ "$OKS" -eq 1 ] && [ "$RETRY" -ge 1 ]; then
  say "PASS concurrent_same_tx"
  pass=$((pass + 1))
else
  say "FAIL concurrent_same_tx"
  fail=$((fail + 1))
fi

# ---------------- abandon safety ----------------
approve c3 'exact:Airlock' >/dev/null
env AIRLOCK_GATE_TEST_CRASH_AFTER=artifact "$DT" airlock-gate sign --gate-home "$H" \
  --wallet "$SENDER" --identity "$IDENTITY" --proposal "$W/valid.proven" \
  --approval-id c3 --output "$W/c3a.signed" >"$W/c3a.log" 2>&1
say "state after c3 crash: $(list_line c3)"
expect abandon_refuses_with_artifact 'E_AUTH_ARTIFACT_EXISTS' \
  "$DT" airlock-gate approvals --gate-home "$H" abandon c3
expect abandon_force 'ABANDONED' "$DT" airlock-gate approvals --gate-home "$H" abandon c3 --force
say "state after force abandon: $(list_line c3)"
if list_line c3 | grep -q "bound=Some(\"$TXID1\")" && list_line c3 | grep -q 'status=Abandoned'; then
  say "PASS abandon_retains_binding"
  pass=$((pass + 1))
else
  say "FAIL abandon_retains_binding"
  fail=$((fail + 1))
fi
expect abandoned_cannot_sign 'E_AUTH_CONSUMED' gsign "$W/valid.proven" c3 "$W/c3b.signed"
expect abandoned_other_tx_consumed 'E_AUTH_CONSUMED' gsign "$W/zeromemo.proven" c3 "$W/c3c.signed"
expect abandon_completed_refused 'E_AUTH_CONSUMED' \
  "$DT" airlock-gate approvals --gate-home "$H" abandon m_valid

approve l1 'exact:Airlock' >/dev/null
if command -v flock >/dev/null 2>&1; then
  flock "$H/locks/l1.lock" -c 'sleep 2' &
  fpid=$!
  sleep 0.4
  expect lock_blocks_abandon 'E_AUTH_IN_USE' \
    "$DT" airlock-gate approvals --gate-home "$H" abandon l1
  wait "$fpid"
  expect abandon_after_lock_release 'ABANDONED' \
    "$DT" airlock-gate approvals --gate-home "$H" abandon l1
else
  say "SKIP lock_blocks_abandon (flock not installed)"
fi

# ---------------- expiry / tip ----------------
approve t1 'exact:Airlock' >/dev/null
expect tip_unavailable_fails_closed 'E_TIP_UNAVAILABLE' \
  env AIRLOCK_GATE_TEST_FORCE_TIP_UNAVAILABLE=1 "$DT" airlock-gate sign \
  --gate-home "$H" --wallet "$SENDER" --identity "$IDENTITY" \
  --proposal "$W/valid.proven" --approval-id t1 --output "$W/t1.signed"
say "state after tip failure: $(list_line t1)"
if list_line t1 | grep -q 'status=Pending'; then
  say "PASS tip_failure_did_not_consume"
  pass=$((pass + 1))
else
  say "FAIL tip_failure_did_not_consume"
  fail=$((fail + 1))
fi

mkdir -p "$W/wallet-main"
python3 - "$SENDER/keys.toml" "$W/wallet-main/keys.toml" <<'PY'
import re
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
if re.search(r'^network\s*=.*$', text, re.M):
    text = re.sub(r'^network\s*=.*$', 'network = "main"', text, count=1, flags=re.M)
else:
    text = 'network = "main"\n' + text
open(dst, 'w').write(text)
print("mainnet-config-written")
PY
approve t2 'exact:Airlock' >/dev/null
expect wrong_network_wallet 'E_WALLET_NETWORK' \
  "$DT" airlock-gate validate --gate-home "$H" --wallet "$W/wallet-main" \
  --identity "$IDENTITY" --proposal "$W/valid.proven" --approval-id t2

# ---------------- corrupt state fails closed ----------------
approve c1 'exact:Airlock' >/dev/null
echo 'garbage' >"$H/approvals/c1.rec"
expect corrupt_record_fails_closed 'E_AUTH_TAMPERED|E_STATE_CORRUPT' \
  gsign "$W/valid.proven" c1 "$W/c1.signed"
rm -f "$H/approvals/c1.rec"

approve c2 'exact:Airlock' >/dev/null
printf '{"approval_id":"c2","txid":"%064d","pid":1,"at_unix":0}\n' 0 \
  >"$H/reservations/c2.json"
expect ambiguous_reservation_fails_closed 'E_STATE_CORRUPT' \
  gsign "$W/valid.proven" c2 "$W/c2.signed"

# ---------------- artifact retention checks ----------------
mv "$H/signed/$TXID1.pczt" "$W/$TXID1.pczt.bak"
expect completed_missing_artifact 'E_STATE_CORRUPT' gsign "$W/valid.proven" m_valid "$W/m_valid2.signed"
mv "$W/$TXID1.pczt.bak" "$H/signed/$TXID1.pczt"

# ---------------- restricted interface cannot override config ----------------
expect submit_rejects_gate_home 'unexpected argument|E_PATH_UNSAFE' \
  "$DT" airlock-gate submit --gate-home "$H" --socket /tmp/none.sock \
  --approval-id m_valid --proposal "$W/valid.proven"

say ""
say "SUMMARY pass=$pass fail=$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
