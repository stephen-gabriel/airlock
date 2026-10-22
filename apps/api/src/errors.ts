import type { Check, SafeError } from '../../../packages/contracts/api.js';

export type Disposition = 'rejected' | 'blocked' | 'failed' | 'expired';

export interface GateDecision {
  error: SafeError;
  disposition: Disposition;
  field: Check['field'] | null;
}

const policyFields: Record<string, Check['field']> = {
  E_POLICY_RECIPIENT: 'recipient',
  E_POLICY_NETWORK: 'network',
  E_POLICY_AMOUNT: 'amount',
  E_POLICY_FEE: 'fee',
  E_POLICY_MEMO: 'memo',
  E_POLICY_EXTRA_OUTPUT: 'recipient',
  E_POLICY_NO_PAYMENT: 'recipient',
  E_POLICY_ZERO_OUTPUT: 'amount',
  E_POLICY_DUMMY_SK: 'authorization',
};

const messages: Record<string, string> = {
  E_POLICY_RECIPIENT: 'The proposed destination does not match the approved recipient.',
  E_POLICY_NETWORK: 'The approved recipient is not a testnet address in the supported context.',
  E_POLICY_AMOUNT: 'The proposed amount does not exactly match the approved amount.',
  E_POLICY_FEE: 'The proposed fee exceeds the approved maximum fee.',
  E_POLICY_MEMO: 'The proposed memo bytes do not exactly match the approved memo.',
  E_POLICY_EXTRA_OUTPUT: 'The proposal contains an output that is not the approved payment or wallet change.',
  E_POLICY_NO_PAYMENT: 'The proposal contains no output matching the approved payment.',
  E_POLICY_ZERO_OUTPUT: 'The proposal contains a zero-value output.',
  E_POLICY_DUMMY_SK: 'The proposal contains a disallowed dummy spend key.',
  E_AUTH_NO_APPROVAL: 'No approval with that identifier exists.',
  E_AUTH_TAMPERED: 'The stored approval record failed its integrity check.',
  E_AUTH_CONSUMED: 'This approval is already bound to a different payment.',
  E_AUTH_IN_USE: 'This approval is currently being processed. Retry shortly.',
  E_AUTH_EXISTS: 'That approval identifier already exists.',
  E_AUTH_EXPIRED: 'This approval has expired.',
  E_AUTH_NETWORK: 'The approval is not for the supported test network.',
  E_AUTH_ARTIFACT_EXISTS: 'An artifact already exists for this approval.',
  E_EXPIRY: 'The proposal expiry is outside the accepted chain window.',
  E_TIP_UNAVAILABLE: 'The signer has no trustworthy local chain tip; signing is blocked.',
  E_UNSUPPORTED_VERSION: 'The proposal transaction version is not supported.',
  E_UNSUPPORTED_NETWORK_CONTEXT: 'The proposal network context is not supported.',
  E_UNSUPPORTED_POOL: 'The proposal uses a pool or component outside the supported scope.',
  E_NO_SIGNABLE_SPEND: 'The proposal has no spend that this signer can authorize.',
  E_FOREIGN_SPEND: 'The proposal contains a nonzero spend not owned by the signer.',
  E_PRE_SIGNED_INVALID: 'A pre-signed padding signature in the proposal is invalid.',
  E_CRYPTO_VERIFY: 'The proposal failed cryptographic verification.',
  E_CRYPTO_OVK_RECOVERY: 'The signer could not recover the approved payment output.',
  E_CRYPTO_RECIPIENT_MISMATCH: 'The recovered output recipient disagrees with the declared recipient.',
  E_KEY_MISMATCH: 'The proposal key material does not match the signer wallet.',
  E_MISSING_DATA: 'The proposal is missing data required for inspection.',
  E_SIGN_INIT: 'The signer could not initialize over the proposal.',
  E_SIGN_FAILED: 'The signer failed to produce a signature.',
  E_SIGNATURE_VERIFY: 'The signer produced a signature that failed verification.',
  E_NO_SIGNATURE: 'The proposal did not contain the expected signature.',
  E_PARSE: 'The proposal is not a valid supported PCZT.',
  E_PATH_UNSAFE: 'The request referenced an unsafe path and was refused.',
  E_STATE_CORRUPT: 'Signer state is inconsistent and requires operator recovery.',
  E_WALLET_NETWORK: 'The signer wallet is not configured for testnet.',
  E_INTERNAL: 'The signer refused the request for an internal reason.',
  E_SIGNER_UNAVAILABLE: 'The signing service is unavailable.',
  E_WORKER_UNAVAILABLE: 'The proposal worker is unavailable.',
  E_SYNC_FAILED: 'The wallet could not refresh testnet chain context.',
  E_FUNDS_UNAVAILABLE: 'The demo wallet does not currently hold enough spendable testnet funds.',
  E_TIP_STALE: 'The last successful chain sync is too old to sign.',
  E_BUILD_FAILED: 'The constrained builder could not create a proposal.',
  E_PROVE_FAILED: 'The constrained builder could not prove the proposal.',
  E_BROADCAST_UNKNOWN: 'Broadcast outcome is unknown. The original signed artifact is retained for reconciliation.',
  E_BROADCAST_FAILED: 'The original signed artifact could not be broadcast.',
  E_STATUS_UNAVAILABLE: 'Network confirmation cannot be checked right now.',
  E_ARTIFACT_MISSING: 'The retained signed artifact is missing; no replacement payment will be built.',
  E_UNAVAILABLE_SCENARIO: 'That hostile scenario is not produced by this build.',
  E_IDEMPOTENCY_CONFLICT: 'This idempotency key was already used for a different request.',
  E_APPROVAL_CONSUMED: 'This demo approval has already been consumed.',
  E_APPROVAL_EXPIRED: 'This demo approval has expired.',
  E_SCENARIO_NOT_ALLOWED: 'That scenario is not permitted for this approval.',
  E_DEMO_EXHAUSTED: 'No demo allocations are currently available.',
  E_RATE_LIMITED: 'Too many demo sessions were requested. Try again later.',
  E_NO_SESSION: 'A demo session is required.',
  E_NOT_FOUND: 'The requested object was not found.',
  E_ORIGIN: 'The request origin is not allowed.',
  E_BAD_REQUEST: 'The request is malformed.',
  E_BODY_TOO_LARGE: 'The request body is too large.',
  E_METHOD: 'The request method is not allowed.',
  E_TIMEOUT: 'The operation exceeded its time limit.',
  E_WORKER_INTERNAL: 'The proposal worker failed unexpectedly.',
  E_PROTECTED_STATE: 'The request attempted to touch protected signer state.',
};

export function safeMessage(code: string): string {
  return messages[code] ?? 'The request could not be completed.';
}

export function mapGateCode(code: string, stage = 'gate'): GateDecision {
  const safe: SafeError = {
    code,
    message: safeMessage(code),
    stage,
    retryable: false,
  };
  if (code === 'E_AUTH_IN_USE' || code === 'E_TIP_UNAVAILABLE' || code === 'E_STATE_CORRUPT') {
    return { error: { ...safe, retryable: true }, disposition: 'blocked', field: null };
  }
  if (code === 'E_AUTH_EXPIRED') {
    return { error: safe, disposition: 'expired', field: 'expiry' };
  }
  if (code.startsWith('E_POLICY_')) {
    return { error: safe, disposition: 'rejected', field: policyFields[code] ?? null };
  }
  if (code.startsWith('E_AUTH_')) {
    return { error: safe, disposition: 'rejected', field: 'authorization' };
  }
  if (code === 'E_EXPIRY') {
    return { error: safe, disposition: 'rejected', field: 'expiry' };
  }
  if (code === 'E_UNSUPPORTED_VERSION' || code === 'E_UNSUPPORTED_NETWORK_CONTEXT') {
    return { error: safe, disposition: 'rejected', field: 'network' };
  }
  if (code === 'E_UNSUPPORTED_POOL' || code === 'E_NO_SIGNABLE_SPEND' || code === 'E_FOREIGN_SPEND') {
    return { error: safe, disposition: 'rejected', field: 'authorization' };
  }
  return { error: safe, disposition: 'failed', field: null };
}

export function clientError(
  code: string,
  stage: string,
  retryable = false,
  message = safeMessage(code),
): SafeError {
  return { code, message, stage, retryable };
}

export function internalError(code: string, stage: string, message?: string): SafeError {
  return {
    code,
    message: message ?? safeMessage(code),
    stage,
    retryable: false,
  };
}
