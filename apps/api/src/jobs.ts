import type {
  Approval,
  Check,
  Health,
  Job,
  JobState,
  ProposalReport,
  Receipt,
  SafeError,
  Scenario,
  SessionInfo,
} from '../../../packages/contracts/api.js';
import type { ApiConfig } from './config.js';
import { clientError, mapGateCode, safeMessage } from './errors.js';
import { callWorker, WorkerUnavailable, type WorkerError } from './worker-client.js';
import type {
  InventoryApproval,
  SessionRecord,
  Store,
  StoredJob,
  StoredReceipt,
} from './store.js';
import { Mutex, nowIso, randomHex } from './util.js';

const PRE_SIGN_STATES: ReadonlySet<JobState> = new Set([
  'queued',
  'preparing',
  'proving',
  'inspecting',
  'signing',
]);

const SCENARIOS: ReadonlySet<Scenario> = new Set([
  'matching',
  'changed-recipient',
  'hidden-memo',
  'excess-fee',
  'forged-approval',
]);

const SUPPORTED_SCENARIOS: ReadonlySet<Scenario> = new Set([
  'matching',
  'changed-recipient',
  'hidden-memo',
]);

function zecString(zats: string): string {
  const value = BigInt(zats);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${fraction} ZEC`;
}

function zatDisplay(zats: string): string {
  return `${zats} zats (${zecString(zats)})`;
}

function approvedDisplay(field: Check['field'], approval: Approval): string {
  switch (field) {
    case 'network':
      return 'testnet';
    case 'recipient':
      return approval.recipientUa;
    case 'amount':
      return zatDisplay(approval.amountZat);
    case 'fee':
      return `at most ${zatDisplay(approval.maxFeeZat)}`;
    case 'memo':
      return approval.memo.display;
    case 'change':
      return 'wallet change only';
    case 'authorization':
      return 'single-use approval';
    case 'expiry':
      return `expires ${approval.expiresAt}`;
  }
}

function proposedDisplay(
  field: Check['field'],
  approval: Approval,
  report: ProposalReport | null,
): string {
  switch (field) {
    case 'network':
      return 'unexpected network context';
    case 'recipient':
      return report?.recipientUa ?? 'not inspected';
    case 'amount':
      return report ? zatDisplay(report.amountZat) : 'not inspected';
    case 'fee':
      return `above the approved maximum of ${zatDisplay(approval.maxFeeZat)}`;
    case 'memo':
      return report?.memoDisplay ?? 'not inspected';
    case 'change':
      return 'unexpected output set';
    case 'authorization':
      return 'refused by gate';
    case 'expiry':
      return 'outside the accepted chain window';
  }
}

function checksForSuccess(
  approval: Approval,
  report: ProposalReport,
  feeZat: string | null,
): Check[] {
  return [
    {
      field: 'network',
      status: 'match',
      approvedDisplay: 'testnet',
      proposedDisplay: 'testnet',
      source: 'gate',
    },
    {
      field: 'recipient',
      status: 'match',
      approvedDisplay: approval.recipientUa,
      proposedDisplay: report.recipientUa,
      source: 'gate',
    },
    {
      field: 'amount',
      status: 'match',
      approvedDisplay: zatDisplay(approval.amountZat),
      proposedDisplay: zatDisplay(report.amountZat),
      source: 'gate',
    },
    {
      field: 'fee',
      status: 'match',
      approvedDisplay: `at most ${zatDisplay(approval.maxFeeZat)}`,
      proposedDisplay: feeZat ? `${feeZat} zats` : 'within the approved maximum',
      source: 'gate',
    },
    {
      field: 'memo',
      status: 'match',
      approvedDisplay: approval.memo.display,
      proposedDisplay: report.memoDisplay,
      source: 'gate',
    },
    {
      field: 'change',
      status: 'match',
      approvedDisplay: 'wallet change only',
      proposedDisplay: 'gate accepted the output set',
      source: 'gate',
    },
    {
      field: 'authorization',
      status: 'match',
      approvedDisplay: 'single-use approval',
      proposedDisplay: 'approval accepted',
      source: 'gate',
    },
    {
      field: 'expiry',
      status: 'match',
      approvedDisplay: `expires ${approval.expiresAt}`,
      proposedDisplay: 'within the gate window',
      source: 'gate',
    },
  ];
}

function checksForFailure(
  approval: Approval,
  report: ProposalReport | null,
  field: Check['field'] | null,
  reasonCode: string,
): Check[] {
  const fields: Check['field'][] = [
    'network',
    'recipient',
    'amount',
    'fee',
    'memo',
    'change',
    'authorization',
    'expiry',
  ];
  return fields.map((value) => {
    if (value === field) {
      return {
        field: value,
        status: 'mismatch',
        approvedDisplay: approvedDisplay(value, approval),
        proposedDisplay: proposedDisplay(value, approval, report),
        reasonCode,
        source: 'gate',
      };
    }
    return {
      field: value,
      status: 'unknown',
      approvedDisplay: approvedDisplay(value, approval),
      proposedDisplay: null,
      reasonCode: 'not separately confirmed after the gate stopped at the first failure',
      source: 'gate',
    };
  });
}

export function publicSession(session: SessionRecord): SessionInfo {
  return {
    mode: session.mode,
    sessionId: session.sessionId,
    demoSetId: session.demoSetId,
    expiresAt: session.expiresAt,
    approvals: session.approvals,
  };
}

export function publicJob(job: StoredJob): Job {
  const { sessionId: _sessionId, setId: _setId, receiptId: _receiptId, ...rest } = job;
  return rest;
}

export function publicReceipt(receipt: StoredReceipt): Receipt {
  const { sessionId: _sessionId, ...rest } = receipt;
  return rest;
}

interface WorkerHealth {
  gateSocket: boolean;
  lastSyncAt: string | null;
  lastTip: number | null;
  chainContext: 'fresh' | 'stale' | 'unknown';
  funding: Health['funding'];
}

interface WorkerReport {
  report: ProposalReport;
}

interface WorkerSign {
  txid: string;
  recovered: boolean;
  feeZat: string | null;
  artifactSha256: string;
}

interface WorkerBroadcast {
  txid: string;
}

interface WorkerStatus {
  found: boolean;
  minedHeight: number | null;
  syncedAt: string;
}

type WorkerResult<T> = ({ ok: true } & T) | WorkerError;

export class JobService {
  private readonly pending: string[] = [];
  private readonly createMutex = new Mutex();
  private readonly broadcastMutex = new Mutex();
  private readonly lastStatus = new Map<string, number>();
  private processing = false;
  private reconciling = false;
  private stopped = false;
  private reconciler: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ApiConfig,
    private readonly store: Store,
  ) {}

  async init(): Promise<void> {
    await this.recoverOnStartup();
    this.reconciler = setInterval(() => {
      void this.reconcilePending();
    }, 30_000);
    this.reconciler.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconciler) clearInterval(this.reconciler);
    this.reconciler = null;
  }

  private async recoverOnStartup(): Promise<void> {
    const jobs = await this.store.listAllJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (PRE_SIGN_STATES.has(job.state)) {
        const session = await this.store.getSession(job.sessionId);
        if (!session) {
          await this.store.pushStage(job.id, 'blocked', {
            error: clientError(
              'E_APPROVAL_EXPIRED',
              'restart',
              false,
              'The demo session ended before this job finished; no payment was signed.',
            ),
          });
          continue;
        }
        if (now - Date.parse(job.createdAt) > 3_600_000) {
          await this.store.pushStage(job.id, 'blocked', {
            error: clientError(
              'E_TIMEOUT',
              'restart',
              false,
              'This demo job expired while the service was restarting; no payment was signed.',
            ),
          });
          continue;
        }
        await this.store.updateJob(job.id, { state: 'queued', error: null });
        this.pending.push(job.id);
        continue;
      }
      if (job.state === 'broadcasting') {
        await this.updateReceiptStatus(job, 'unknown');
        await this.store.pushStage(job.id, 'broadcast_unknown', {
          error: clientError(
            'E_BROADCAST_UNKNOWN',
            'broadcast',
            true,
            safeMessage('E_BROADCAST_UNKNOWN'),
          ),
        });
      }
    }
    if (this.pending.length > 0) {
      setTimeout(() => {
        void this.drain();
      }, 1_500).unref();
    }
  }

  private enqueue(jobId: string): void {
    if (this.stopped) return;
    if (!this.pending.includes(jobId)) this.pending.push(jobId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (!this.stopped && this.pending.length > 0) {
        const id = this.pending.shift();
        if (!id) break;
        const job = await this.store.getJob(id);
        if (!job || job.state !== 'queued') continue;
        await this.runPipeline(job);
      }
    } finally {
      this.processing = false;
    }
  }

  async createJob(
    session: SessionRecord,
    approvalId: string,
    scenario: Scenario,
    idempotencyKey: string,
    bodyHash: string,
  ): Promise<StoredJob> {
    if (!SCENARIOS.has(scenario)) throw clientError('E_BAD_REQUEST', 'job');
    if (!SUPPORTED_SCENARIOS.has(scenario)) {
      throw clientError('E_UNAVAILABLE_SCENARIO', 'job');
    }
    return this.createMutex.runExclusive(async () => {
      const existing = await this.store.getIdempotency(session.sessionId, idempotencyKey);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          throw clientError('E_IDEMPOTENCY_CONFLICT', 'job');
        }
        const prior = await this.store.getJob(existing.jobId);
        if (prior) return prior;
      }

      const approval = await this.store.findApproval(session, approvalId);
      if (!approval) throw clientError('E_NOT_FOUND', 'job');
      if (approval.status === 'completed') throw clientError('E_APPROVAL_CONSUMED', 'job');
      if (approval.status !== 'pending') throw clientError('E_APPROVAL_CONSUMED', 'job');
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        throw clientError('E_APPROVAL_EXPIRED', 'job');
      }
      if (approval.scenario !== scenario) {
        throw clientError('E_SCENARIO_NOT_ALLOWED', 'job');
      }

      const existingJobs = await this.store.listJobs(session.sessionId);
      const active = existingJobs.find(
        (value) => value.approvalId === approvalId && !this.store.isTerminal(value.state),
      );
      if (active) return active;

      const jobId = existing?.jobId ?? randomHex(16);
      if (!existing) {
        await this.store.putIdempotency(session.sessionId, idempotencyKey, bodyHash, jobId);
      }
      const now = nowIso();
      const job: StoredJob = {
        id: jobId,
        mode: 'live-testnet',
        approvalId,
        scenario,
        state: 'queued',
        checks: [],
        proposal: null,
        createdAt: now,
        updatedAt: now,
        txid: null,
        minedHeight: null,
        artifactId: null,
        artifactSha256: null,
        signedAt: null,
        broadcastAttempts: 0,
        stages: [{ state: 'queued', at: now }],
        error: null,
        sessionId: session.sessionId,
        setId: session.setId,
        receiptId: null,
      };
      await this.store.createJob(job);
      this.enqueue(job.id);
      return job;
    });
  }

  private async workerCall<T>(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkerResult<T>> {
    try {
      return await callWorker<T>(this.config.workerSocket, request, timeoutMs);
    } catch (error) {
      return {
        ok: false,
        code: 'E_WORKER_UNAVAILABLE',
        stage: typeof request.cmd === 'string' ? request.cmd : 'worker',
        message:
          error instanceof WorkerUnavailable
            ? safeMessage('E_WORKER_UNAVAILABLE')
            : safeMessage('E_WORKER_INTERNAL'),
        retryable: true,
      };
    }
  }

  private async runPipeline(job: StoredJob): Promise<void> {
    const approval = await this.store.findApprovalById(job.setId, job.approvalId);
    if (!approval) {
      await this.failJob(job, {
        ok: false,
        code: 'E_AUTH_NO_APPROVAL',
        stage: 'prepare',
        message: safeMessage('E_AUTH_NO_APPROVAL'),
        retryable: false,
      });
      return;
    }

    try {
      await this.store.pushStage(job.id, 'preparing', { error: null });
      const built = await this.workerCall<WorkerReport>(
        {
          cmd: 'build',
          jobId: job.id,
          approvalId: job.approvalId,
          scenario: job.scenario,
        },
        420_000,
      );
      if (!built.ok) {
        await this.failJob(job, built);
        return;
      }
      let report = built.report;
      await this.store.updateJob(job.id, { proposal: report });
      await this.store.pushStage(job.id, 'proving', { proposal: report });

      const proved = await this.workerCall<WorkerReport>({ cmd: 'prove', jobId: job.id }, 420_000);
      if (!proved.ok) {
        await this.failJob(job, proved);
        return;
      }
      report = proved.report;
      await this.store.updateJob(job.id, { proposal: report });
      await this.store.pushStage(job.id, 'signing', { proposal: report });

      const signed = await this.workerCall<WorkerSign>({ cmd: 'sign', jobId: job.id }, 220_000);
      if (!signed.ok) {
        await this.failJob(job, signed, approval);
        return;
      }
      if (report.txid && report.txid !== signed.txid) {
        await this.failJob(job, {
          ok: false,
          code: 'E_STATE_CORRUPT',
          stage: 'sign',
          message: safeMessage('E_STATE_CORRUPT'),
          retryable: false,
        }, approval);
        return;
      }
      report = { ...report, feeZat: signed.feeZat };
      await this.store.updateJob(job.id, { proposal: report });
      const checks = checksForSuccess(approval, report, signed.feeZat);
      const artifactId = `art_${randomHex(8)}`;
      const receipt = await this.createReceipt(job, {
        decision: 'signed',
        reasonCode: signed.recovered ? 'SIGN_RECOVERED_OK' : 'SIGN_OK',
        txid: signed.txid,
        networkStatus: 'not-broadcast',
        minedHeight: null,
        artifactSha256: signed.artifactSha256,
      });
      await this.store.pushStage(job.id, 'signed', {
        proposal: report,
        checks,
        txid: signed.txid,
        artifactId,
        artifactSha256: signed.artifactSha256,
        signedAt: nowIso(),
        error: null,
        receiptId: receipt.id,
      });
      await this.store.updateSessionApproval(job.sessionId, approval.id, {
        status: 'completed',
        boundTxid: signed.txid,
      });
    } catch (error) {
      await this.failJob(job, {
        ok: false,
        code: 'E_INTERNAL',
        stage: 'pipeline',
        message: error instanceof Error ? safeMessage('E_INTERNAL') : safeMessage('E_INTERNAL'),
        retryable: false,
      });
    }
  }

  private async failJob(
    job: StoredJob,
    error: WorkerError,
    approvalArg?: InventoryApproval,
  ): Promise<void> {
    const approval =
      approvalArg ?? (await this.store.findApprovalById(job.setId, job.approvalId));
    const decision = mapGateCode(error.code, error.stage ?? 'gate');
    let state: JobState =
      decision.disposition === 'rejected'
        ? 'rejected'
        : decision.disposition === 'expired'
          ? 'expired'
          : decision.disposition === 'blocked'
            ? 'blocked'
            : 'failed';
    if (
      error.code === 'E_WORKER_UNAVAILABLE' ||
      error.code === 'E_SIGNER_UNAVAILABLE' ||
      error.code === 'E_TIMEOUT' ||
      error.code === 'E_FUNDS_UNAVAILABLE' ||
      error.code === 'E_TIP_STALE'
    ) {
      state = 'blocked';
    }
    const safe: SafeError = {
      code: error.code,
      message: error.message || safeMessage(error.code),
      stage: error.stage ?? 'gate',
      retryable: Boolean(error.retryable) || state === 'blocked',
    };
    const checks = approval
      ? checksForFailure(approval, job.proposal, decision.field, error.code)
      : job.checks;
    let receiptId = job.receiptId;
    if (state === 'rejected' || state === 'expired') {
      const receipt = await this.createReceipt(job, {
        decision: 'rejected',
        reasonCode: error.code,
        txid: job.txid,
        networkStatus: 'not-broadcast',
        minedHeight: job.minedHeight,
      });
      receiptId = receipt.id;
    }
    if (error.code === 'E_AUTH_CONSUMED') {
      await this.store.updateSessionApproval(job.sessionId, job.approvalId, {
        status: 'completed',
      });
    }
    await this.store.pushStage(job.id, state, { error: safe, checks, receiptId });
  }

  private async createReceipt(
    job: StoredJob,
    input: {
      decision: Receipt['decision'];
      reasonCode: string;
      txid: string | null;
      networkStatus: Receipt['networkStatus'];
      minedHeight: number | null;
      artifactSha256?: string;
    },
  ): Promise<StoredReceipt> {
    const receipt: StoredReceipt = {
      id: `rcpt_${randomHex(8)}`,
      mode: 'live-testnet',
      jobId: job.id,
      approvalId: job.approvalId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      txid: input.txid,
      networkStatus: input.networkStatus,
      minedHeight: input.minedHeight,
      createdAt: nowIso(),
      sessionId: job.sessionId,
    };
    if (input.artifactSha256) receipt.artifactSha256 = input.artifactSha256;
    await this.store.createReceipt(receipt);
    return receipt;
  }

  private async updateReceiptStatus(
    job: StoredJob,
    networkStatus: Receipt['networkStatus'],
    txid?: string,
    minedHeight?: number | null,
  ): Promise<void> {
    if (!job.receiptId) return;
    const receipt = await this.store.getReceipt(job.receiptId);
    if (!receipt) return;
    const patch: Partial<StoredReceipt> = { networkStatus };
    if (txid) patch.txid = txid;
    if (minedHeight !== undefined) patch.minedHeight = minedHeight;
    await this.store.updateReceipt(receipt.id, patch);
  }

  async resume(jobId: string, session: SessionRecord): Promise<StoredJob> {
    return this.createMutex.runExclusive(async () => {
      const job = await this.store.getJob(jobId);
      if (!job || job.sessionId !== session.sessionId) {
        throw clientError('E_NOT_FOUND', 'resume');
      }
      if (job.state !== 'blocked' && job.state !== 'failed') {
        throw clientError(
          'E_BAD_REQUEST',
          'resume',
          false,
          'Only a blocked or failed job can be resumed.',
        );
      }
      if (!job.error?.retryable) {
        throw clientError(
          'E_BAD_REQUEST',
          'resume',
          false,
          'This job stopped in a state that requires operator recovery.',
        );
      }
      if (job.signedAt && job.txid && job.artifactSha256) {
        await this.updateReceiptStatus(job, 'not-broadcast', job.txid);
        return this.store.pushStage(job.id, 'signed', { error: null });
      }

      const approval = await this.store.findApprovalById(job.setId, job.approvalId);
      if (!approval) throw clientError('E_NOT_FOUND', 'resume');
      if (approval.status === 'completed') throw clientError('E_APPROVAL_CONSUMED', 'resume');
      if (approval.status !== 'pending') throw clientError('E_APPROVAL_CONSUMED', 'resume');
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        throw clientError('E_APPROVAL_EXPIRED', 'resume');
      }

      const active = (await this.store.listJobs(session.sessionId)).find(
        (value) =>
          value.id !== job.id &&
          value.approvalId === job.approvalId &&
          !this.store.isTerminal(value.state),
      );
      if (active) throw clientError('E_AUTH_IN_USE', 'resume', true);

      const queued = await this.store.pushStage(job.id, 'queued', { error: null });
      this.enqueue(queued.id);
      return queued;
    });
  }

  private async reconcileKnownTransaction(job: StoredJob): Promise<StoredJob | null> {
    if (!job.txid) return null;
    const result = await this.workerCall<WorkerStatus>(
      { cmd: 'status', jobId: job.id, txid: job.txid },
      180_000,
    );
    if (!result.ok || !result.found) return null;
    if (result.minedHeight !== null) {
      await this.updateReceiptStatus(job, 'confirmed', job.txid, result.minedHeight);
      return this.store.pushStage(job.id, 'confirmed', {
        minedHeight: result.minedHeight,
        error: null,
      });
    }
    await this.updateReceiptStatus(job, 'pending', job.txid);
    return this.store.pushStage(job.id, 'pending', { error: null });
  }

  async broadcast(jobId: string, session: SessionRecord): Promise<StoredJob> {
    return this.broadcastMutex.runExclusive(async () => {
      const job = await this.store.getJob(jobId);
      if (!job || job.sessionId !== session.sessionId) {
        throw clientError('E_NOT_FOUND', 'broadcast');
      }
      if (job.state === 'pending' || job.state === 'confirmed') return job;
      if (job.state === 'broadcasting') return job;
      if (job.state !== 'signed' && job.state !== 'broadcast_unknown') {
        throw clientError(
          'E_BAD_REQUEST',
          'broadcast',
          false,
          'Only a job with a retained signed artifact can be broadcast.',
        );
      }

      if (job.state === 'broadcast_unknown') {
        const known = await this.reconcileKnownTransaction(job);
        if (known) return known;
      }

      const priorAttempts = job.broadcastAttempts;
      await this.store.pushStage(job.id, 'broadcasting', {
        broadcastAttempts: priorAttempts + 1,
        error: null,
      });
      const result = await this.workerCall<WorkerBroadcast>(
        { cmd: 'broadcast', jobId: job.id },
        220_000,
      );
      if (!result.ok) {
        const safe: SafeError = {
          code: result.code === 'E_BROADCAST_UNKNOWN' ? 'E_BROADCAST_UNKNOWN' : result.code,
          message: result.message || safeMessage('E_BROADCAST_UNKNOWN'),
          stage: result.stage ?? 'broadcast',
          retryable: result.code !== 'E_ARTIFACT_MISSING',
        };
        if (result.code === 'E_ARTIFACT_MISSING' && job.state === 'signed') {
          await this.updateReceiptStatus(job, 'not-broadcast');
          return this.store.pushStage(job.id, 'failed', { error: safe });
        }
        if (result.code === 'E_ARTIFACT_MISSING') {
          return this.store.pushStage(job.id, 'broadcast_unknown', { error: safe });
        }
        await this.updateReceiptStatus(job, 'unknown');
        return this.store.pushStage(job.id, 'broadcast_unknown', { error: safe });
      }
      if (job.txid && job.txid !== result.txid) {
        await this.updateReceiptStatus(job, 'unknown', result.txid);
        const corrupt: SafeError = {
          code: 'E_STATE_CORRUPT',
          message: safeMessage('E_STATE_CORRUPT'),
          stage: 'broadcast',
          retryable: false,
        };
        return this.store.pushStage(job.id, 'broadcast_unknown', {
          txid: result.txid,
          error: corrupt,
        });
      }
      await this.updateReceiptStatus(job, 'pending', result.txid);
      return this.store.pushStage(job.id, 'pending', { txid: result.txid, error: null });
    });
  }

  async refreshStatus(jobId: string, session: SessionRecord, force = false): Promise<StoredJob> {
    const job = await this.store.getJob(jobId);
    if (!job || job.sessionId !== session.sessionId) throw clientError('E_NOT_FOUND', 'status');
    return this.checkJobStatus(job, force);
  }

  private async checkJobStatus(job: StoredJob, force: boolean): Promise<StoredJob> {
    if (job.state !== 'pending' && job.state !== 'broadcast_unknown') return job;
    if (!job.txid) return job;
    const last = this.lastStatus.get(job.id) ?? 0;
    if (!force && Date.now() - last < 15_000) return job;
    this.lastStatus.set(job.id, Date.now());
    const result = await this.workerCall<WorkerStatus>(
      { cmd: 'status', jobId: job.id, txid: job.txid },
      180_000,
    );
    if (!result.ok) return job;
    if (!result.found) return job;
    if (result.minedHeight !== null) {
      await this.updateReceiptStatus(job, 'confirmed', job.txid, result.minedHeight);
      return this.store.pushStage(job.id, 'confirmed', {
        minedHeight: result.minedHeight,
        error: null,
      });
    }
    if (job.state === 'broadcast_unknown') {
      await this.updateReceiptStatus(job, 'pending', job.txid);
      return this.store.pushStage(job.id, 'pending', { error: null });
    }
    return job;
  }

  private async reconcilePending(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const jobs = await this.store.listAllJobs();
      let checked = 0;
      for (const job of jobs) {
        if (checked >= 3) break;
        if (job.state !== 'pending' && job.state !== 'broadcast_unknown') continue;
        if (Date.now() - Date.parse(job.createdAt) > 86_400_000) continue;
        checked += 1;
        await this.checkJobStatus(job, false);
      }
    } catch {
      // Reconciliation is best-effort and must never crash the API.
    } finally {
      this.reconciling = false;
    }
  }

  async health(): Promise<Health> {
    const inventory = this.store.getInventoryOrNull();
    const demoSetsRemaining =
      inventory?.sets.filter(
        (set) =>
          set.status === 'available' &&
          set.approvals.every((approval) => Date.parse(approval.expiresAt) > Date.now()),
      ).length ?? 0;
    const sessionSlotsRemaining = await this.store
      .sessionSlotsRemaining(this.config.globalSessionLimit)
      .catch(() => 0);
    const offline: Health = {
      mode: 'live-testnet',
      status: 'offline',
      signer: 'unavailable',
      chainContext: 'unknown',
      funding: 'unknown',
      demoSetsRemaining,
      sessionSlotsRemaining,
      acceptingDemoSessions: false,
      reason: 'proposal worker unavailable',
    };
    let worker: WorkerResult<WorkerHealth>;
    try {
      worker = await callWorker<WorkerHealth>(
        this.config.workerSocket,
        { cmd: 'health' },
        5_000,
      );
    } catch {
      return offline;
    }
    if (!worker.ok) return offline;
    const signer = worker.gateSocket ? 'available' : 'unavailable';
    const chainContext = worker.chainContext;
    const funding = worker.funding ?? 'unknown';
    const accepting =
      demoSetsRemaining > 0 &&
      sessionSlotsRemaining > 0 &&
      signer === 'available' &&
      chainContext !== 'stale' &&
      funding !== 'insufficient';
    const status: Health['status'] =
      accepting && chainContext === 'fresh' ? 'ready' : 'degraded';
    let reason: string | undefined;
    if (funding === 'insufficient') {
      reason = 'demo wallet funding is insufficient';
    } else if (demoSetsRemaining === 0) {
      reason = 'demo inventory is exhausted';
    } else if (sessionSlotsRemaining === 0) {
      reason = 'demo session quota is exhausted';
    } else if (signer !== 'available') {
      reason = 'signing service is unavailable';
    } else if (chainContext === 'stale') {
      reason = 'chain context is stale';
    } else if (chainContext === 'unknown') {
      reason = 'chain context has not been observed yet';
    }
    return {
      mode: 'live-testnet',
      status,
      signer,
      chainContext,
      funding,
      demoSetsRemaining,
      sessionSlotsRemaining,
      acceptingDemoSessions: accepting,
      ...(reason ? { reason } : {}),
    };
  }
}
