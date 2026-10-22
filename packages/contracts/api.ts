/**
 * Airlock live API contract.
 *
 * Reconciles the proposed kit contract with the repaired gate CLI and the
 * constrained worker. All monetary values are unsigned decimal zatoshis.
 * This file is shared by the API and the browser bundle at build time only;
 * no value from the browser is trusted by the gate.
 */

export type Mode = 'live-testnet' | 'recorded-evidence';

/** Unsigned decimal integer string. Never a float. */
export type Zatoshis = string;

/** Public demo scenarios. `excess-fee` is declared for compatibility but is
 * not produced by the current builder; the API reports it unavailable rather
 * than fabricating a gate result. */
export type Scenario =
  | 'matching'
  | 'changed-recipient'
  | 'hidden-memo'
  | 'excess-fee'
  | 'forged-approval';

export type JobState =
  | 'queued'
  | 'preparing'
  | 'proving'
  | 'inspecting'
  | 'signing'
  | 'signed'
  | 'broadcasting'
  | 'broadcast_unknown'
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'blocked'
  | 'failed'
  | 'expired';

export type ApprovalStatus = 'pending' | 'reserved' | 'completed' | 'abandoned';

export interface Approval {
  id: string;
  network: 'testnet';
  recipientUa: string;
  recipientLabel?: string;
  amountZat: Zatoshis;
  maxFeeZat: Zatoshis;
  memo: { display: string; encoding: 'canonical-512'; policy: 'exact' | 'empty' };
  expiresAt: string;
  status: ApprovalStatus;
  singlePayment: true;
  boundTxid: string | null;
  /** Demo scenario this operator-created permission is assigned to. */
  scenario: Scenario;
}

export interface Check {
  field: 'network' | 'recipient' | 'amount' | 'fee' | 'memo' | 'change' | 'expiry' | 'authorization';
  status: 'match' | 'mismatch' | 'unknown';
  approvedDisplay: string;
  proposedDisplay: string | null;
  reasonCode?: string;
  source: 'gate';
}

/** Public-safe fields describing the artifact the constrained builder created.
 * The gate decision, not this report, authorizes signing. */
export interface ProposalReport {
  txid: string | null;
  recipientUa: string;
  amountZat: Zatoshis;
  memoDisplay: string;
  feeZat: Zatoshis | null;
  expiryHeight: number | null;
  artifactSha256: string | null;
  source: 'trusted-builder';
}

export interface SafeError {
  code: string;
  message: string;
  stage: string;
  retryable: boolean;
}

export interface CreateJobRequest {
  approvalId: string;
  scenario: Scenario;
}

export interface Job {
  id: string;
  mode: 'live-testnet';
  approvalId: string;
  scenario: Scenario;
  state: JobState;
  checks: Check[];
  proposal: ProposalReport | null;
  createdAt: string;
  updatedAt: string;
  txid: string | null;
  minedHeight: number | null;
  artifactId: string | null;
  artifactSha256: string | null;
  signedAt: string | null;
  broadcastAttempts: number;
  stages: { state: JobState; at: string }[];
  error: SafeError | null;
  retryAfterMs?: number;
}

export interface Health {
  mode: 'live-testnet';
  status: 'ready' | 'degraded' | 'offline';
  signer: 'available' | 'unavailable';
  chainContext: 'fresh' | 'stale' | 'unknown';
  funding: 'available' | 'unknown' | 'insufficient';
  demoSetsRemaining: number;
  sessionSlotsRemaining: number;
  acceptingDemoSessions: boolean;
  reason?: string;
}

export interface SessionInfo {
  mode: 'live-testnet';
  sessionId: string;
  demoSetId: string;
  expiresAt: string;
  approvals: Approval[];
}

export interface Receipt {
  id: string;
  mode: Mode;
  capturedAt?: string;
  jobId: string;
  approvalId: string;
  decision: 'signed' | 'rejected';
  reasonCode: string;
  txid: string | null;
  networkStatus: 'not-broadcast' | 'unknown' | 'pending' | 'confirmed' | 'expired';
  minedHeight: number | null;
  createdAt: string;
  artifactSha256?: string;
}

export interface ErrorResponse {
  mode: 'live-testnet';
  requestId: string;
  error: SafeError;
  jobId?: string;
}

export interface JobListResponse {
  mode: 'live-testnet';
  jobs: Job[];
}

export interface ReceiptListResponse {
  mode: 'live-testnet';
  receipts: Receipt[];
}

export interface SessionCreateResponse extends SessionInfo {}
