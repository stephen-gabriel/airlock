// Policy compares a proposal only. It never authorizes, verifies a proof or guesses change.
export const MAX_POLICY_CHARS = 16384;
const MAX_MONEY = 2100000000000000n;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)
  && BigInt(value) <= MAX_MONEY;
const hex = (value, length) => typeof value === 'string'
  && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value);
const height = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function parsePolicy(text) {
  if (typeof text !== 'string' || text.length > MAX_POLICY_CHARS) throw new Error('Policy exceeds 16384 characters');
  const policy = JSON.parse(text);
  if (!policy || Array.isArray(policy) || typeof policy !== 'object'
      || Object.keys(policy).some(key => !['coinTypeClaim', 'branchId', 'minExpiry', 'maxExpiry', 'maxFeeZat', 'outputs'].includes(key))
      || !height(policy.coinTypeClaim) || !hex(policy.branchId, 8)
      || !height(policy.minExpiry) || !height(policy.maxExpiry) || policy.minExpiry > policy.maxExpiry
      || !decimal(policy.maxFeeZat) || !Array.isArray(policy.outputs)
      || policy.outputs.length < 1 || policy.outputs.length > 8
      || policy.outputs.some(output => !output || typeof output !== 'object'
        || Object.keys(output).some(key => !['recipientRaw', 'amountZat', 'memoHex'].includes(key))
        || !hex(output.recipientRaw, 86) || !decimal(output.amountZat) || !hex(output.memoHex, 1024))) {
    throw new Error('Invalid policy: exact raw Ironwood receivers, decimal zat strings and full 512-byte memo hex required');
  }
  return policy;
}

export function comparePolicy(report, policy) {
  const fields = [];
  const add = (field, equal, evidence, available = true, expected = null, actual = null, checks = []) => fields.push({
    field, status: !available ? 'unavailable' : equal ? 'matches' : 'mismatch',
    matchesClaim: available ? Boolean(equal) : null, evidence, expected, actual,
    valueStatus: actual === null || actual === undefined ? 'unavailable' : equal ? 'matches' : 'mismatch',
    bindingStatus: checks.length ? ['inconsistent', 'unavailable', 'reconstructed'].find(
      status => checks.some(check => check.status === status)) || 'consistent' : null,
    group: ['coinTypeClaim', 'branchId', 'expiryHeight'].includes(field) ? 'metadata' : 'outputs',
  });
  if (!report.parsed || report.scope !== 'supported') {
    return { status: 'unavailable', reason: 'Input rejected or outside implemented checking scope', fields };
  }
  add('coinTypeClaim', report.metadata.coinTypeClaim === policy.coinTypeClaim, 'Unauthenticated PCZT metadata, NOT verified network', true, policy.coinTypeClaim, report.metadata.coinTypeClaim);
  add('branchId', report.metadata.branchId === policy.branchId.toLowerCase(), 'Transaction branch field, NOT verified network', true, policy.branchId, report.metadata.branchId);
  add('expiryHeight', report.metadata.expiryHeight >= policy.minExpiry && report.metadata.expiryHeight <= policy.maxExpiry,
    'Static transaction-field bound, NOT current-chain freshness', true, `${policy.minExpiry}–${policy.maxExpiry}`, report.metadata.expiryHeight);
  add('outputCount', report.actions.length === policy.outputs.length, 'All action outputs count, including zero-value/dummy outputs; no change inference', true, policy.outputs.length, report.actions.length);
  add('maxFeeZat', decimal(report.fee.disclosedNetZat) && BigInt(report.fee.disclosedNetZat) <= BigInt(policy.maxFeeZat),
    'Disclosed net compared to supplied cv_net and declared value balance, conditional on valid inputs',
    report.fee.status === 'consistent', `≤ ${policy.maxFeeZat}`, report.fee.disclosedNetZat, [report.fee]);
  policy.outputs.forEach((expected, index) => {
    const actual = report.actions[index];
    if (!actual) { add(`output[${index}]`, false, 'Expected output absent', true, 'Output required', 'Absent'); return; }
    add(`output[${index}].recipientRaw`, actual.recipientRaw === expected.recipientRaw.toLowerCase(),
      'Disclosed raw receiver compared to supplied cmx, NOT user_address label',
      actual.noteCommitment.status === 'consistent' && actual.recipientRaw !== null, expected.recipientRaw, actual.recipientRaw, [actual.noteCommitment]);
    add(`output[${index}].amountZat`, actual.amountZat === expected.amountZat,
      'Disclosed amount compared to supplied cmx and cv_net',
      actual.noteCommitment.status === 'consistent' && actual.valueCommitment.status === 'consistent', expected.amountZat, actual.amountZat, [actual.noteCommitment, actual.valueCommitment]);
    add(`output[${index}].memoHex`, actual.memo.hex === expected.memoHex.toLowerCase(),
      'Exact 512 bytes from authenticated supplied ciphertext',
      actual.memo.status === 'consistent' && actual.memo.cmxSource !== 'reconstructed', expected.memoHex, actual.memo.hex ?? null,
      [actual.memo, ...(actual.memo.cmxSource === 'reconstructed' ? [actual.noteCommitment] : [])]);
  });
  // Spend and cross-address checks are separate coverage, not output-policy evidence.
  const inconsistent = report.fee.status === 'inconsistent'
    || report.actions.some(action => ['noteCommitment', 'valueCommitment', 'memo']
      .some(field => action[field].status === 'inconsistent'));
  const summarize = rows => rows.some(field => field.status === 'mismatch') ? 'mismatch'
    : rows.some(field => field.status === 'unavailable') ? 'unavailable' : 'matches_proposal';
  const outputStatus = inconsistent ? 'mismatch' : summarize(fields.filter(field => field.group === 'outputs'));
  const metadataStatus = summarize(fields.filter(field => field.group === 'metadata'));
  return {
    status: outputStatus === 'mismatch' || metadataStatus === 'mismatch' ? 'mismatch' : outputStatus,
    outputStatus, metadataStatus,
    // Raw value differences remain visible even if their cryptographic binding failed.
    policyMismatch: fields.some(field => field.valueStatus === 'mismatch'),
    disclosedOutputStatus: summarize(fields.filter(field => field.group === 'outputs')
      .map(field => ({ status: field.valueStatus }))),
    meaning: 'Proposal comparison only. Network, ownership, proof, signatures, chain state and payment are NOT verified.',
    fields,
  };
}

export function disclosureCoverage(report) {
  if (!report.parsed || report.scope !== 'supported') {
    return { status: 'unsupported', checks: [], counts: {} };
  }
  const checks = [
    { field: 'Conditional fee balance', kind: 'fee', ...report.fee },
    { field: 'Cross-address restriction', kind: 'crossAddressRestriction', ...report.crossAddressRestriction },
    ...report.actions.flatMap((action, index) => [
      ['noteCommitment', 'Note commitment'], ['valueCommitment', 'Net value commitment'],
      ['memo', 'Memo ciphertext'], ['nullifier', 'Spend nullifier'], ['randomizedKey', 'Randomized key'],
    ].map(([key, label]) => ({ field: `Output ${index + 1} · ${label}`, kind: key, ...action[key] }))),
  ];
  const counts = {};
  for (const check of checks) counts[check.status] = (counts[check.status] || 0) + 1;
  return {
    status: counts.inconsistent ? 'inconsistent'
      : counts.unavailable || counts.reconstructed ? 'incomplete' : 'consistent',
    checks, counts,
  };
}

export function explainComparison(field) {
  const values = field.valueStatus === 'mismatch' ? 'The disclosed value differs from your expected policy.'
    : field.valueStatus === 'matches' ? 'The disclosed value agrees with your policy.'
      : 'No disclosed value is available to compare.';
  if (field.bindingStatus === 'inconsistent') return `${values} Cryptographic disclosure checks failed, so this is not a bound policy match. See disclosure coverage for the failed checks.`;
  if (field.bindingStatus === 'reconstructed') return `${values} Binding evidence was reconstructed, not independently supplied. No checked policy match is claimed.`;
  if (field.status === 'unavailable') return `${values} Required disclosure evidence is missing or unrecoverable. No checked policy match is claimed; see disclosure coverage.`;
  if (field.group === 'metadata') return `${values} This compares metadata or a static bound, not actual network or current expiry.`;
  if (field.field.endsWith('.memoHex')) return `${values} Equality uses all 512 original bytes, never the text preview. Supplied ciphertext authentication is consistent.`;
  return `${values} ${field.evidence}.`;
}

export function explainDisclosure(check) {
  const purpose = {
    fee: 'Check the conditional fee against disclosed spend/output values, net value commitments and the declared balance.',
    crossAddressRestriction: 'Check that restricted transfers use the required spend/output receivers.',
    noteCommitment: 'Recompute the output note commitment (cmx) from the disclosed receiver, value and random seed.',
    valueCommitment: 'Recompute the net value commitment (cv_net) from spend/output values and commitment randomness (rcv).',
    memo: 'Recover and authenticate all 512 memo bytes from the supplied note ciphertext.',
    nullifier: 'Recompute the paired spend nullifier from its note disclosures and full viewing key (FVK).',
    randomizedKey: 'Recompute the randomized spend key (rk) from the full viewing key (FVK) and spend randomizer (alpha).',
  }[check.kind] || 'Check the supplied disclosure.';
  const missing = {
    MissingFullViewingKey: 'The full viewing key (FVK) is missing.',
    MissingRandomSeed: 'The note random seed (rseed) is missing.',
    MissingRecipient: 'A required receiver is missing.',
    MissingRho: 'The spend note rho is missing.',
    MissingSpendAuthRandomizer: 'The spend randomizer (alpha) is missing.',
    MissingValue: 'A required note value is missing.',
    MissingValueCommitTrapdoor: 'Value-commitment randomness (rcv) is missing.',
  }[check.reason];
  if (check.status === 'not_applicable') return 'This bundle permits cross-address transfers, so the receiver restriction check does not apply. This is not a passed cryptographic check.';
  if (check.status === 'unavailable') return `${missing || (check.kind === 'memo'
    ? 'One or more required output disclosures (receiver, value or rseed) are missing.'
    : check.kind === 'fee' ? 'Required note values, commitment randomness or independently supplied net value commitments are unavailable.'
      : 'Required disclosures are missing.')} Cannot ${purpose[0].toLowerCase()}${purpose.slice(1)} No consistent result is claimed.`;
  if (check.status === 'reconstructed') return check.kind === 'memo'
    ? 'The checker re-encrypted disclosed memo plaintext instead of authenticating independently supplied ciphertext. The 512 derived bytes are available for inspection. Reconstruction is not verification.'
    : `${purpose} The checker derived the field from disclosures instead of comparing independent supplied evidence. Reconstruction is not verification.`;
  if (check.status === 'inconsistent') return `${purpose} The supplied disclosures do not agree with the commitment, ciphertext or balance. This is a cryptographic disclosure inconsistency, not just a difference from your policy.`;
  if (check.kind === 'memo' && check.cmxSource === 'reconstructed') return `${purpose} Ciphertext authentication is consistent only against a reconstructed cmx. No independent supplied note commitment was checked.`;
  return `${purpose} Supplied evidence is consistent. This does not verify proofs, signatures, funding or wallet authority.`;
}
