const FIXTURE_NOW = '2026-10-22T02:00:00.000Z';
const FIXTURE_EXPIRES = '2099-01-01T00:00:00.000Z';
const FIXTURE_TXID = 'f'.repeat(64);
const FIXTURE_ARTIFACT = 'a'.repeat(64);
const FIXTURE_RECIPIENT = `utest1fixture${'0'.repeat(160)}`;
const FIXTURE_DEMO_SET = 'fixture-set';
const FIXTURE_SESSION = 'fixture-session';

function approval(scenario, status = 'pending', boundTxid = null) {
  return {
    id: `fixture-approval-${scenario}`,
    network: 'testnet',
    recipientUa: FIXTURE_RECIPIENT,
    recipientLabel: 'Fixture recipient',
    amountZat: '100000',
    maxFeeZat: '10000',
    memo: {
      display: 'Airlock fixture',
      encoding: 'canonical-512',
      policy: 'exact',
    },
    expiresAt: FIXTURE_EXPIRES,
    status,
    singlePayment: true,
    boundTxid,
    scenario,
  };
}

function matchChecks() {
  return [
    { field: 'network', status: 'match', approvedDisplay: 'testnet', proposedDisplay: 'testnet', source: 'gate' },
    { field: 'recipient', status: 'match', approvedDisplay: FIXTURE_RECIPIENT, proposedDisplay: FIXTURE_RECIPIENT, source: 'gate' },
    { field: 'amount', status: 'match', approvedDisplay: '0.00100000 TAZ', proposedDisplay: '0.00100000 TAZ', source: 'gate' },
    { field: 'fee', status: 'match', approvedDisplay: 'at most 0.00010000 TAZ', proposedDisplay: '0.00010000 TAZ', source: 'gate' },
    { field: 'memo', status: 'match', approvedDisplay: 'Airlock fixture', proposedDisplay: 'Airlock fixture', source: 'gate' },
    { field: 'change', status: 'match', approvedDisplay: 'wallet change only', proposedDisplay: 'wallet change only', source: 'gate' },
    { field: 'expiry', status: 'match', approvedDisplay: 'expires Jan 1, 2099', proposedDisplay: 'expiry height 4600000', source: 'gate' },
    { field: 'authorization', status: 'match', approvedDisplay: 'single-use approval', proposedDisplay: 'single-use approval', source: 'gate' },
  ];
}

function proposal() {
  return {
    txid: FIXTURE_TXID,
    recipientUa: FIXTURE_RECIPIENT,
    amountZat: '100000',
    memoDisplay: 'Airlock fixture',
    feeZat: '10000',
    expiryHeight: 4600000,
    artifactSha256: FIXTURE_ARTIFACT,
    source: 'trusted-builder',
  };
}

function job(state) {
  const createdAt = FIXTURE_NOW;
  const updatedAt = '2026-10-22T02:00:10.000Z';
  const stages = [
    { state: 'preparing', at: '2026-10-22T02:00:01.000Z' },
    { state: 'proving', at: '2026-10-22T02:00:02.000Z' },
    { state: 'signing', at: '2026-10-22T02:00:03.000Z' },
    { state: 'signed', at: '2026-10-22T02:00:04.000Z' },
  ];
  if (state === 'pending' || state === 'broadcast_unknown') {
    stages.push({ state: 'broadcasting', at: '2026-10-22T02:00:05.000Z' });
    stages.push({ state, at: '2026-10-22T02:00:06.000Z' });
  }
  return {
    id: `fixture-job-${state}`,
    mode: 'live-testnet',
    approvalId: 'fixture-approval-matching',
    scenario: 'matching',
    state,
    checks: matchChecks(),
    proposal: proposal(),
    createdAt,
    updatedAt,
    txid: FIXTURE_TXID,
    minedHeight: null,
    artifactId: `fixture-artifact-${state}`,
    artifactSha256: FIXTURE_ARTIFACT,
    signedAt: '2026-10-22T02:00:04.000Z',
    broadcastAttempts: state === 'signed' ? 0 : 1,
    stages,
    error: state === 'broadcast_unknown'
      ? {
          code: 'E_BROADCAST_UNKNOWN',
          message: 'The test broadcaster could not confirm whether the transaction reached the network.',
          stage: 'broadcast',
          retryable: true,
        }
      : null,
  };
}

function receipt(state) {
  const networkStatus = {
    signed: 'not-broadcast',
    pending: 'pending',
    broadcast_unknown: 'unknown',
  }[state];
  return {
    id: `fixture-receipt-${state}`,
    mode: 'live-testnet',
    jobId: `fixture-job-${state}`,
    approvalId: 'fixture-approval-matching',
    decision: 'signed',
    reasonCode: state === 'broadcast_unknown' ? 'E_BROADCAST_UNKNOWN' : 'SIGN_OK',
    txid: FIXTURE_TXID,
    networkStatus,
    minedHeight: null,
    createdAt: FIXTURE_NOW,
    artifactSha256: FIXTURE_ARTIFACT,
  };
}

function session(approvals) {
  return {
    mode: 'live-testnet',
    sessionId: FIXTURE_SESSION,
    demoSetId: FIXTURE_DEMO_SET,
    expiresAt: FIXTURE_EXPIRES,
    approvals,
  };
}

function health(overrides = {}) {
  return {
    mode: 'live-testnet',
    status: 'ready',
    signer: 'available',
    chainContext: 'fresh',
    funding: 'available',
    demoSetsRemaining: 0,
    sessionSlotsRemaining: 199,
    acceptingDemoSessions: false,
    ...overrides,
  };
}

const fixtures = {
  'no-approvals': () => ({
    description: 'Session allocated from an empty test inventory.',
    session: session([]),
    health: health(),
    jobs: [],
    receipts: [],
  }),
  'no-funds': () => ({
    description: 'Controlled insufficient-funds health response with a pending approval.',
    session: session([approval('matching')]),
    health: health({
      status: 'degraded',
      funding: 'insufficient',
      reason: 'Test fixture: spendable balance is below the approval ceiling.',
    }),
    jobs: [],
    receipts: [],
  }),
  'gate-unavailable': () => ({
    description: 'The test gate endpoint is disconnected; no real gate service is involved.',
    session: session([approval('matching')]),
    health: health({
      status: 'offline',
      signer: 'unavailable',
      chainContext: 'unknown',
      funding: 'unknown',
      demoSetsRemaining: 0,
      sessionSlotsRemaining: 199,
      acceptingDemoSessions: false,
      reason: 'The test gate endpoint is disconnected.',
    }),
    jobs: [],
    receipts: [],
  }),
  signed: () => ({
    description: 'Deterministic signed fixture. No signature or broadcast occurred.',
    session: session([approval('matching', 'completed', FIXTURE_TXID)]),
    health: health(),
    jobs: [job('signed')],
    receipts: [receipt('signed')],
  }),
  pending: () => ({
    description: 'Deterministic pending fixture. No transaction was broadcast.',
    session: session([approval('matching', 'completed', FIXTURE_TXID)]),
    health: health(),
    jobs: [job('pending')],
    receipts: [receipt('pending')],
  }),
  broadcast_unknown: () => ({
    description: 'Deterministic broadcast-unknown fixture. No transaction was broadcast.',
    session: session([approval('matching', 'completed', FIXTURE_TXID)]),
    health: health(),
    jobs: [job('broadcast_unknown')],
    receipts: [receipt('broadcast_unknown')],
  }),
};

export const scenarioNames = Object.keys(fixtures);

export function buildFixture(scenario) {
  const factory = fixtures[scenario];
  if (!factory) throw new Error(`Unknown fixture scenario: ${scenario}`);
  return {
    scenario,
    fixtureVersion: 1,
    testOnly: true,
    realIntegration: false,
    ...factory(),
  };
}
