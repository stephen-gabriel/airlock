#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/airlock-lib.sh"

need_file "$RECIPIENT_UA_FILE"
need_file "$ALT_RECIPIENT_UA_FILE"
need_exec "$DEVTOOL_BIN"
[ -d "$GATE_HOME" ] || die "missing gate home: $GATE_HOME"

RECIPIENT_UA="$(tr -d '\r\n' <"$RECIPIENT_UA_FILE")"
ALT_RECIPIENT_UA="$(tr -d '\r\n' <"$ALT_RECIPIENT_UA_FILE")"
[ -n "$RECIPIENT_UA" ] || die "recipient UA file is empty"
[ -n "$ALT_RECIPIENT_UA" ] || die "alternate recipient UA file is empty"

APPEND="${AIRLOCK_PROVISION_APPEND:-0}"
if [ "$APPEND" = "1" ]; then
  [ -f "$INVENTORY_FILE" ] || die "append requested but inventory is missing: $INVENTORY_FILE"
  [ -f "$WORKER_CONFIG" ] || die "append requested but worker config is missing: $WORKER_CONFIG"
else
  if [ -f "$INVENTORY_FILE" ]; then
    die "inventory already exists: $INVENTORY_FILE (set AIRLOCK_PROVISION_APPEND=1 to append)"
  fi
  if [ -f "$WORKER_CONFIG" ]; then
    die "worker config already exists: $WORKER_CONFIG (set AIRLOCK_PROVISION_APPEND=1 to append)"
  fi
fi

for id in "$MATCH_ID" "$RECIPIENT_ID" "$MEMO_ID"; do
  for suffix in rec json mac; do
    path="$GATE_HOME/approvals/$id.$suffix"
    if [ -e "$path" ]; then
      die "approval file already exists: $path"
    fi
  done
done

ensure_dirs

approve() {
  local id="$1"
  local output expiry
  output="$("$DEVTOOL_BIN" airlock-gate approve \
    --gate-home "$GATE_HOME" \
    --id "$id" \
    --recipient "$RECIPIENT_UA" \
    --amount "$APPROVAL_AMOUNT" \
    --max-fee "$APPROVAL_MAX_FEE" \
    --memo-policy "exact:$APPROVAL_MEMO" \
    --expires-in "$APPROVAL_EXPIRES_IN")"
  printf '%s\n' "$output" >&2
  expiry="$(printf '%s\n' "$output" | sed -n 's/.*expires_at=\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  [ -n "$expiry" ] || die "could not parse expires_at for $id"
  printf '%s\n' "$expiry"
}

MATCH_EXPIRES="$(approve "$MATCH_ID")"
RECIPIENT_EXPIRES="$(approve "$RECIPIENT_ID")"
MEMO_EXPIRES="$(approve "$MEMO_ID")"

"$NODE_BIN" - \
  "$INVENTORY_FILE" \
  "$WORKER_CONFIG" \
  "$APPEND" \
  "$SET_ID" \
  "$MATCH_ID" \
  "$MATCH_EXPIRES" \
  "$RECIPIENT_ID" \
  "$RECIPIENT_EXPIRES" \
  "$MEMO_ID" \
  "$MEMO_EXPIRES" \
  "$RECIPIENT_UA" \
  "$ALT_RECIPIENT_UA" \
  "$APPROVAL_AMOUNT" \
  "$APPROVAL_MAX_FEE" \
  "$APPROVAL_MEMO" <<'NODE'
const fs = require('node:fs');
const [
  inventoryPath,
  workerPath,
  appendRaw,
  setId,
  matchId,
  matchExpires,
  recipientId,
  recipientExpires,
  memoId,
  memoExpires,
  recipientUa,
  altRecipientUa,
  amountZat,
  maxFeeZat,
  memoText,
] = process.argv.slice(2);
const append = appendRaw === '1';

const now = new Date().toISOString();
const approval = (id, role, expires) => ({
  id,
  network: 'testnet',
  recipientUa,
  recipientLabel: 'Airlock demo recipient',
  amountZat,
  maxFeeZat,
  memo: { display: memoText, encoding: 'canonical-512', policy: 'exact' },
  expiresAt: new Date(Number(expires) * 1000).toISOString(),
  status: 'pending',
  singlePayment: true,
  boundTxid: null,
  scenario: role,
  role,
});

const approvals = [
  approval(matchId, 'matching', matchExpires),
  approval(recipientId, 'changed-recipient', recipientExpires),
  approval(memoId, 'hidden-memo', memoExpires),
];

const set = {
  id: setId,
  status: 'available',
  sessionId: null,
  assignedAt: null,
  createdAt: now,
  approvals,
};

const workerSet = {
  approvals: Object.fromEntries(
    approvals.map((value) => [
      value.role,
      {
        id: value.id,
        role: value.role,
        recipientUa: value.recipientUa,
        amountZat: value.amountZat,
        maxFeeZat: value.maxFeeZat,
        memo: { display: value.memo.display, policy: value.memo.policy },
        expiresAt: value.expiresAt,
      },
    ]),
  ),
};

let inventory;
let worker;
if (append) {
  inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  worker = JSON.parse(fs.readFileSync(workerPath, 'utf8'));
  if (!Array.isArray(inventory.sets) || !worker.sets) {
    throw new Error('existing inventory or worker config has an unsupported shape');
  }
  if (inventory.sets.some((value) => value.id === setId) || worker.sets[setId]) {
    throw new Error(`set already exists: ${setId}`);
  }
  inventory.sets.push(set);
  inventory.updatedAt = now;
  worker.sets[setId] = workerSet;
  worker.altRecipientUa = altRecipientUa;
} else {
  inventory = {
    version: 1,
    network: 'testnet',
    updatedAt: now,
    sets: [set],
  };
  worker = {
    version: 1,
    network: 'testnet',
    altRecipientUa,
    sets: { [setId]: workerSet },
    limits: { maxAmountZat: '1000000', maxFeeZat: '100000' },
  };
}

fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(workerPath, `${JSON.stringify(worker, null, 2)}\n`, { mode: 0o600 });
NODE

chmod 600 "$INVENTORY_FILE" "$WORKER_CONFIG"
log "provisioned $SET_ID"
log "inventory: $INVENTORY_FILE"
log "worker config: $WORKER_CONFIG"
log "approvals: $MATCH_ID ($MATCH_EXPIRES), $RECIPIENT_ID ($RECIPIENT_EXPIRES), $MEMO_ID ($MEMO_EXPIRES)"
