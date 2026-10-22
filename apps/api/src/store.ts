import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Approval,
  Job,
  JobState,
  Receipt,
  Scenario,
  SessionInfo,
} from '../../../packages/contracts/api.js';
import {
  atomicWrite,
  atomicWriteJson,
  ensureDir,
  isSafeId,
  Mutex,
  nowIso,
  nowUnix,
  randomHex,
  readJson,
  safeEqual,
  sha256Hex,
} from './util.js';
import { clientError } from './errors.js';

export interface InventoryApproval extends Approval {
  role: 'matching' | 'changed-recipient' | 'hidden-memo';
}

export interface InventorySet {
  id: string;
  status: 'available' | 'assigned' | 'consumed' | 'expired';
  sessionId: string | null;
  assignedAt: string | null;
  createdAt: string;
  approvals: InventoryApproval[];
}

export interface InventoryFile {
  version: 1;
  network: 'testnet';
  updatedAt: string;
  sets: InventorySet[];
}

export interface SessionRecord extends SessionInfo {
  createdAt: string;
  setId: string;
  ipHash: string;
}

export interface StoredJob extends Job {
  sessionId: string;
  setId: string;
  receiptId: string | null;
}

export interface StoredReceipt extends Receipt {
  sessionId: string;
}

interface IdempotencyRecord {
  sessionId: string;
  key: string;
  bodyHash: string;
  jobId: string;
  createdAt: string;
}

interface RateRecord {
  perIp: Record<string, number[]>;
  global: number[];
}

const TERMINAL: ReadonlySet<JobState> = new Set([
  'confirmed',
  'rejected',
  'failed',
  'blocked',
  'expired',
]);

export class Store {
  private readonly dirs: {
    sessions: string;
    jobs: string;
    receipts: string;
    idem: string;
  };
  private readonly mutex = new Mutex();
  private secret: Buffer | null = null;
  private inventory: InventoryFile | null = null;

  constructor(private readonly stateDir: string) {
    this.dirs = {
      sessions: path.join(stateDir, 'sessions'),
      jobs: path.join(stateDir, 'jobs'),
      receipts: path.join(stateDir, 'receipts'),
      idem: path.join(stateDir, 'idem'),
    };
  }

  async init(): Promise<void> {
    await ensureDir(this.stateDir, 0o700);
    await Promise.all(Object.values(this.dirs).map((dir) => ensureDir(dir, 0o700)));
    this.secret = await this.loadOrCreateSecret();
    this.inventory = await this.loadInventory();
  }

  private async loadOrCreateSecret(): Promise<Buffer> {
    const file = path.join(this.stateDir, 'secret.key');
    try {
      const value = await fs.readFile(file);
      if (value.length !== 32) throw new Error('invalid session secret length');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const value = Buffer.from(randomHex(32), 'hex');
      await atomicWrite(file, value, 0o600);
      return value;
    }
  }

  private async loadInventory(): Promise<InventoryFile | null> {
    const file = path.join(this.stateDir, 'inventory.json');
    const value = await readJson<InventoryFile>(file);
    if (!value) return null;
    if (value.version !== 1 || !Array.isArray(value.sets)) {
      throw new Error('inventory.json has an unsupported shape');
    }
    return value;
  }

  getInventoryOrNull(): InventoryFile | null {
    return this.inventory;
  }

  private async persistInventory(): Promise<void> {
    if (!this.inventory) return;
    this.inventory.updatedAt = nowIso();
    await atomicWriteJson(path.join(this.stateDir, 'inventory.json'), this.inventory, 0o600);
  }

  private secretValue(): Buffer {
    if (!this.secret) throw new Error('store not initialized');
    return this.secret;
  }

  signSessionId(sessionId: string): string {
    return createHmac('sha256', this.secretValue()).update(sessionId).digest('hex');
  }

  hashIp(ip: string): string {
    return createHmac('sha256', this.secretValue()).update(`ip:${ip}`).digest('hex');
  }

  makeSessionCookieValue(sessionId: string): string {
    return `${sessionId}.${this.signSessionId(sessionId)}`;
  }

  parseSessionCookieValue(value: string): string | null {
    const index = value.indexOf('.');
    if (index < 1) return null;
    const sessionId = value.slice(0, index);
    const signature = value.slice(index + 1);
    if (!isSafeId(sessionId, 64)) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;
    return safeEqual(signature, this.signSessionId(sessionId)) ? sessionId : null;
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.dirs.sessions, `${sessionId}.json`);
  }

  private jobFile(jobId: string): string {
    return path.join(this.dirs.jobs, `${jobId}.json`);
  }

  private receiptFile(receiptId: string): string {
    return path.join(this.dirs.receipts, `${receiptId}.json`);
  }

  private idemFile(sessionId: string, key: string): string {
    return path.join(this.dirs.idem, `${sha256Hex(`${sessionId}\u0000${key}`)}.json`);
  }

  private async loadRate(): Promise<RateRecord> {
    return (await readJson<RateRecord>(path.join(this.stateDir, 'rate.json'))) ?? {
      perIp: {},
      global: [],
    };
  }

  private pruneRate(record: RateRecord, now: number): void {
    const cutoff = now - 3600;
    record.global = record.global.filter((t) => t >= cutoff);
    for (const [ip, times] of Object.entries(record.perIp)) {
      const kept = times.filter((t) => t >= cutoff);
      if (kept.length === 0) delete record.perIp[ip];
      else record.perIp[ip] = kept;
    }
  }

  async allocateSession(
    ipHash: string,
    limits: { perIp: number; global: number; ttlSeconds: number },
  ): Promise<SessionRecord> {
    return this.mutex.runExclusive(async () => {
      if (!this.inventory) {
        throw clientError('E_DEMO_EXHAUSTED', 'session', false);
      }
      const now = nowUnix();
      const rate = await this.loadRate();
      this.pruneRate(rate, now);
      const globalCount = rate.global.length;
      const ipCount = rate.perIp[ipHash]?.length ?? 0;
      if (globalCount >= limits.global || ipCount >= limits.perIp) {
        throw clientError('E_RATE_LIMITED', 'session', true);
      }

      for (const set of this.inventory.sets) {
        if (set.status !== 'available') continue;
        const expired = set.approvals.some((a) => Date.parse(a.expiresAt) <= Date.now());
        if (expired) {
          set.status = 'expired';
          continue;
        }
        const sessionId = randomHex(16);
        const ttl = Math.min(
          limits.ttlSeconds,
          Math.max(
            60,
            Math.floor(
              Math.min(...set.approvals.map((a) => Date.parse(a.expiresAt))) / 1000 - now,
            ),
          ),
        );
        const session: SessionRecord = {
          mode: 'live-testnet',
          sessionId,
          demoSetId: set.id,
          expiresAt: new Date((now + ttl) * 1000).toISOString(),
          approvals: set.approvals.map((a) => this.publicApproval(a)),
          createdAt: nowIso(),
          setId: set.id,
          ipHash,
        };
        await atomicWriteJson(this.sessionFile(sessionId), session, 0o600);
        set.status = 'assigned';
        set.sessionId = sessionId;
        set.assignedAt = nowIso();
        await this.persistInventory();
        rate.global.push(now);
        rate.perIp[ipHash] = [...(rate.perIp[ipHash] ?? []), now];
        await atomicWriteJson(path.join(this.stateDir, 'rate.json'), rate, 0o600);
        return session;
      }
      await this.persistInventory();
      throw clientError('E_DEMO_EXHAUSTED', 'session', false);
    });
  }

  async sessionSlotsRemaining(limit: number): Promise<number> {
    const rate = await this.loadRate();
    this.pruneRate(rate, nowUnix());
    return Math.max(0, limit - rate.global.length);
  }

  private publicApproval(approval: InventoryApproval): Approval {
    const { role: _role, ...rest } = approval;
    return rest;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    if (!isSafeId(sessionId, 64)) return null;
    const session = await readJson<SessionRecord>(this.sessionFile(sessionId));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) return null;
    return session;
  }

  async updateSessionApproval(
    sessionId: string,
    approvalId: string,
    patch: Partial<InventoryApproval>,
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.inventory) return;
      for (const set of this.inventory.sets) {
        if (set.sessionId !== sessionId) continue;
        const approval = set.approvals.find((a) => a.id === approvalId);
        if (!approval) return;
        Object.assign(approval, patch);
        if (set.approvals.every((a) => a.status === 'completed')) set.status = 'consumed';
        await this.persistInventory();
        return;
      }
    });
  }

  async getApprovalsForSession(session: SessionRecord): Promise<Approval[]> {
    if (!this.inventory) return session.approvals;
    const set = this.inventory.sets.find((s) => s.id === session.setId);
    if (!set) return session.approvals;
    return set.approvals.map((a) => this.publicApproval(a));
  }

  async findApproval(session: SessionRecord, approvalId: string): Promise<InventoryApproval | null> {
    if (!this.inventory || !isSafeId(approvalId)) return null;
    const set = this.inventory.sets.find((s) => s.id === session.setId);
    return set?.approvals.find((a) => a.id === approvalId) ?? null;
  }

  async findApprovalById(setId: string, approvalId: string): Promise<InventoryApproval | null> {
    if (!this.inventory || !isSafeId(approvalId)) return null;
    const set = this.inventory.sets.find((s) => s.id === setId);
    return set?.approvals.find((a) => a.id === approvalId) ?? null;
  }

  async createJob(job: StoredJob): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await atomicWriteJson(this.jobFile(job.id), job, 0o600);
    });
  }

  async getJob(jobId: string): Promise<StoredJob | null> {
    if (!isSafeId(jobId)) return null;
    return readJson<StoredJob>(this.jobFile(jobId));
  }

  async listJobs(sessionId: string): Promise<StoredJob[]> {
    const files = await fs.readdir(this.dirs.jobs).catch(() => []);
    const jobs: StoredJob[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const job = await readJson<StoredJob>(path.join(this.dirs.jobs, file));
      if (job?.sessionId === sessionId) jobs.push(job);
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs;
  }

  async listAllJobs(): Promise<StoredJob[]> {
    const files = await fs.readdir(this.dirs.jobs).catch(() => []);
    const jobs: StoredJob[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const job = await readJson<StoredJob>(path.join(this.dirs.jobs, file));
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return jobs;
  }

  async mutateJob<T>(jobId: string, fn: (job: StoredJob) => T | Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const file = this.jobFile(jobId);
      const job = await readJson<StoredJob>(file);
      if (!job) throw clientError('E_NOT_FOUND', 'job', false);
      const result = await fn(job);
      job.updatedAt = nowIso();
      await atomicWriteJson(file, job, 0o600);
      return result;
    });
  }

  async updateJob(jobId: string, patch: Partial<StoredJob>): Promise<StoredJob> {
    return this.mutex.runExclusive(async () => {
      const file = this.jobFile(jobId);
      const job = await readJson<StoredJob>(file);
      if (!job) throw clientError('E_NOT_FOUND', 'job', false);
      Object.assign(job, patch, { updatedAt: nowIso() });
      await atomicWriteJson(file, job, 0o600);
      return job;
    });
  }

  async pushStage(jobId: string, state: JobState, patch: Partial<StoredJob> = {}): Promise<StoredJob> {
    return this.mutex.runExclusive(async () => {
      const file = this.jobFile(jobId);
      const job = await readJson<StoredJob>(file);
      if (!job) throw clientError('E_NOT_FOUND', 'job', false);
      Object.assign(job, patch, { state, updatedAt: nowIso() });
      if (job.stages[job.stages.length - 1]?.state !== state) {
        job.stages.push({ state, at: job.updatedAt });
      }
      await atomicWriteJson(file, job, 0o600);
      return job;
    });
  }

  isTerminal(state: JobState): boolean {
    return TERMINAL.has(state);
  }

  async getIdempotency(sessionId: string, key: string): Promise<IdempotencyRecord | null> {
    return readJson<IdempotencyRecord>(this.idemFile(sessionId, key));
  }

  async putIdempotency(
    sessionId: string,
    key: string,
    bodyHash: string,
    jobId: string,
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const record: IdempotencyRecord = {
        sessionId,
        key,
        bodyHash,
        jobId,
        createdAt: nowIso(),
      };
      await atomicWriteJson(this.idemFile(sessionId, key), record, 0o600);
    });
  }

  async createReceipt(receipt: StoredReceipt): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await atomicWriteJson(this.receiptFile(receipt.id), receipt, 0o600);
    });
  }

  async getReceipt(receiptId: string): Promise<StoredReceipt | null> {
    if (!isSafeId(receiptId)) return null;
    return readJson<StoredReceipt>(this.receiptFile(receiptId));
  }

  async listReceipts(sessionId: string): Promise<StoredReceipt[]> {
    const files = await fs.readdir(this.dirs.receipts).catch(() => []);
    const receipts: StoredReceipt[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const receipt = await readJson<StoredReceipt>(path.join(this.dirs.receipts, file));
      if (receipt?.sessionId === sessionId) receipts.push(receipt);
    }
    receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return receipts;
  }

  async updateReceipt(receiptId: string, patch: Partial<StoredReceipt>): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const file = this.receiptFile(receiptId);
      const receipt = await readJson<StoredReceipt>(file);
      if (!receipt) return;
      Object.assign(receipt, patch);
      await atomicWriteJson(file, receipt, 0o600);
    });
  }
}
