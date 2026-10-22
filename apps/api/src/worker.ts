import { promises as fs, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { WorkerApprovalTerms, TrustedWorkerConfig } from './config.js';
import { assertTestnetAddress, loadWorkerRuntimeConfig } from './config.js';
import {
  broadcastArtifact,
  checkGateSocket,
  createProposal,
  gateSubmit,
  hashFile,
  proveProposal,
  syncWallet,
  walletTxStatus,
  type GatePaths,
} from './gate.js';
import { safeMessage } from './errors.js';
import {
  assertPathInside,
  atomicWriteJson,
  ensureDir,
  isHex64,
  isSafeId,
  isZatString,
  Mutex,
  nowIso,
  readJson,
} from './util.js';

interface WorkerState {
  lastSyncAt: string | null;
  lastTip: number | null;
  lastSpendableZat: string | null;
}

interface JobMeta {
  version: 1;
  jobId: string;
  setId: string;
  approvalId: string;
  scenario: WorkerApprovalTerms['role'];
  recipientUa: string;
  amountZat: string;
  maxFeeZat: string;
  memoDisplay: string;
  memoHex: string | null;
  createdAt: string;
  createdSha256: string | null;
  provenSha256: string | null;
  signedSha256: string | null;
  txid: string | null;
  signedTxid: string | null;
  signedFeeZat: string | null;
  recovered: boolean;
}

interface WorkerRequest {
  cmd?: unknown;
  jobId?: unknown;
  approvalId?: unknown;
  scenario?: unknown;
  txid?: unknown;
}

interface ApprovalIndexEntry {
  setId: string;
  terms: WorkerApprovalTerms;
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false as const,
    code,
    stage,
    message: safeMessage(code),
    retryable: code === 'E_TIP_UNAVAILABLE' || code === 'E_SIGNER_UNAVAILABLE' || code === 'E_AUTH_IN_USE',
    ...extra,
  };
}

const runtime = loadWorkerRuntimeConfig();
const paths: GatePaths = {
  devtoolBin: runtime.devtoolBin,
  gateHome: runtime.gateHome,
  gateSocket: runtime.gateSocket,
  walletDir: runtime.walletDir,
  identityFile: runtime.identityFile,
  recipientWalletDir: runtime.recipientWalletDir,
};

let trustedConfig: TrustedWorkerConfig;
const approvalIndex = new Map<string, ApprovalIndexEntry>();
const jobMutex = new Mutex();
let workerState: WorkerState = { lastSyncAt: null, lastTip: null, lastSpendableZat: null };

function stateFile(): string {
  return path.join(runtime.spoolDir, 'worker-state.json');
}

function logLine(line: string): void {
  process.stderr.write(`${nowIso()} ${line}\n`);
}

async function appendJobLog(jobDir: string, label: string, value: string): Promise<void> {
  try {
    await fs.appendFile(path.join(jobDir, 'worker.log'), `\n[${nowIso()}] ${label}\n${value}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best-effort local diagnostics.
  }
}

function validateWorkerConfig(config: TrustedWorkerConfig): void {
  if (config.version !== 1 || config.network !== 'testnet') {
    throw new Error('worker config must be version 1 testnet');
  }
  if (!assertTestnetAddress(config.altRecipientUa)) {
    throw new Error('altRecipientUa must be a testnet address');
  }
  if (!isZatString(config.limits.maxAmountZat) || !isZatString(config.limits.maxFeeZat)) {
    throw new Error('worker limits must be decimal zatoshis');
  }
  for (const [setId, set] of Object.entries(config.sets)) {
    if (!isSafeId(setId)) throw new Error('invalid set id');
    for (const [key, terms] of Object.entries(set.approvals)) {
      if (!isSafeId(terms.id)) throw new Error('invalid approval id');
      if (approvalIndex.has(terms.id)) throw new Error('duplicate approval id in worker config');
      if (terms.role !== key) throw new Error('approval role/key mismatch');
      if (!['matching', 'changed-recipient', 'hidden-memo'].includes(terms.role)) {
        throw new Error('unsupported approval role');
      }
      if (!assertTestnetAddress(terms.recipientUa)) throw new Error('approval recipient not testnet');
      if (!isZatString(terms.amountZat) || !isZatString(terms.maxFeeZat)) {
        throw new Error('approval amounts must be decimal zatoshis');
      }
      if (BigInt(terms.amountZat) > BigInt(config.limits.maxAmountZat)) {
        throw new Error('approval amount exceeds worker limit');
      }
      if (BigInt(terms.maxFeeZat) > BigInt(config.limits.maxFeeZat)) {
        throw new Error('approval fee exceeds worker limit');
      }
      if (!Number.isFinite(Date.parse(terms.expiresAt))) throw new Error('invalid approval expiry');
      if (terms.memo.policy === 'exact' && terms.memo.display.length === 0) {
        throw new Error('empty exact memo is not supported');
      }
      approvalIndex.set(terms.id, { setId, terms });
    }
  }
}

async function loadState(): Promise<void> {
  const value = await readJson<WorkerState>(stateFile());
  if (value) workerState = value;
}

async function saveState(): Promise<void> {
  await atomicWriteJson(stateFile(), workerState, 0o600);
}

function jobIdFrom(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{32,64}$/.test(value) ? value : null;
}

function jobDir(jobId: string): string {
  const dir = path.join(runtime.spoolDir, jobId);
  assertPathInside(runtime.spoolDir, dir);
  return dir;
}

async function loadMeta(jobId: string): Promise<JobMeta | null> {
  return readJson<JobMeta>(path.join(jobDir(jobId), 'meta.json'));
}

async function saveMeta(meta: JobMeta): Promise<void> {
  await atomicWriteJson(path.join(jobDir(meta.jobId), 'meta.json'), meta, 0o600);
}

function report(meta: JobMeta, provenSha256: string | null) {
  return {
    txid: meta.txid,
    recipientUa: meta.recipientUa,
    amountZat: meta.amountZat,
    memoDisplay: meta.memoDisplay,
    feeZat: null,
    expiryHeight: null,
    artifactSha256: provenSha256 ?? meta.createdSha256,
    source: 'trusted-builder' as const,
  };
}

async function build(
  jobId: string,
  approvalId: string,
  scenario: WorkerApprovalTerms['role'],
): Promise<Record<string, unknown>> {
  const entry = approvalIndex.get(approvalId);
  if (!entry) return fail('E_AUTH_NO_APPROVAL', 'build');
  if (entry.terms.role !== scenario) return fail('E_SCENARIO_NOT_ALLOWED', 'build');
  if (Date.parse(entry.terms.expiresAt) <= Date.now()) return fail('E_AUTH_EXPIRED', 'build');

  const dir = jobDir(jobId);
  await ensureDir(dir, 0o700);
  const metaPath = path.join(dir, 'meta.json');
  const createdPath = path.join(dir, 'proposal.pczt');
  const meta = await loadMeta(jobId);

  if (meta) {
    if (meta.approvalId !== approvalId || meta.scenario !== scenario) {
      return fail('E_PROTECTED_STATE', 'build');
    }
    if (await fs.stat(createdPath).catch(() => null)) {
      return { ok: true, report: report(meta, await hashFile(path.join(dir, 'proposal.proven'))) };
    }
  }

  const sync = await syncWallet(runtime.walletDir, runtime.devtoolBin, 150_000);
  if (!sync.ok) {
    await appendJobLog(dir, 'sync failed', sync.detail);
    return fail(sync.code, sync.stage);
  }
  const spendableValue = sync.balanceJson?.ironwood_spendable;
  const spendableZat =
    typeof spendableValue === 'string' || typeof spendableValue === 'number'
      ? String(spendableValue)
      : null;
  workerState = { lastSyncAt: nowIso(), lastTip: sync.tip, lastSpendableZat: spendableZat };
  await saveState();

  if (spendableZat && isZatString(spendableZat)) {
    const needed = BigInt(entry.terms.amountZat) + BigInt(entry.terms.maxFeeZat);
    if (BigInt(spendableZat) < needed) {
      return fail('E_FUNDS_UNAVAILABLE', 'build');
    }
  }

  let recipientUa = entry.terms.recipientUa;
  let memoText = entry.terms.memo.display;
  let memoHex: string | null = null;
  if (scenario === 'changed-recipient') {
    recipientUa = trustedConfig.altRecipientUa;
    memoText = entry.terms.memo.display;
  } else if (scenario === 'hidden-memo') {
    const hidden = Buffer.concat([
      Buffer.from(entry.terms.memo.display, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('EVIL', 'utf8'),
    ]);
    memoHex = hidden.toString('hex');
    memoText = `${entry.terms.memo.display} [hidden suffix 00 45 56 49 4c]`;
  }

  const created = await createProposal(paths, {
    recipientUa,
    amountZat: entry.terms.amountZat,
    memoText: entry.terms.memo.display,
    memoHex,
    createdPath,
  });
  if (!created.ok) {
    await appendJobLog(dir, 'create failed', created.detail);
    return fail(created.code, created.stage);
  }
  const createdSha = await hashFile(createdPath);
  if (!createdSha) return fail('E_BUILD_FAILED', 'build');

  const next: JobMeta = {
    version: 1,
    jobId,
    setId: entry.setId,
    approvalId,
    scenario,
    recipientUa,
    amountZat: entry.terms.amountZat,
    maxFeeZat: entry.terms.maxFeeZat,
    memoDisplay: memoText,
    memoHex,
    createdAt: nowIso(),
    createdSha256: createdSha,
    provenSha256: null,
    signedSha256: null,
    txid: created.txid,
    signedTxid: null,
    signedFeeZat: null,
    recovered: false,
  };
  await saveMeta(next);
  return { ok: true, report: report(next, null) };
}

async function prove(jobId: string): Promise<Record<string, unknown>> {
  const dir = jobDir(jobId);
  const meta = await loadMeta(jobId);
  if (!meta) return fail('E_NOT_FOUND', 'prove');
  const createdPath = path.join(dir, 'proposal.pczt');
  const provenPath = path.join(dir, 'proposal.proven');
  const createdSha = await hashFile(createdPath);
  if (!createdSha || createdSha !== meta.createdSha256) return fail('E_STATE_CORRUPT', 'prove');
  const existing = await hashFile(provenPath);
  if (existing) {
    if (meta.provenSha256 !== existing) {
      meta.provenSha256 = existing;
      await saveMeta(meta);
    }
    return { ok: true, report: report(meta, existing) };
  }
  const result = await proveProposal(paths, createdPath, provenPath);
  if (!result.ok) {
    await appendJobLog(dir, 'prove failed', result.detail);
    return fail(result.code, result.stage);
  }
  const provenSha = await hashFile(provenPath);
  if (!provenSha) return fail('E_PROVE_FAILED', 'prove');
  meta.provenSha256 = provenSha;
  await saveMeta(meta);
  return { ok: true, report: report(meta, provenSha) };
}

async function sign(jobId: string): Promise<Record<string, unknown>> {
  const dir = jobDir(jobId);
  const meta = await loadMeta(jobId);
  if (!meta) return fail('E_NOT_FOUND', 'sign');
  const provenPath = path.join(dir, 'proposal.proven');
  const signedPath = path.join(dir, 'signed.pczt');
  const provenSha = await hashFile(provenPath);
  if (!provenSha || provenSha !== meta.provenSha256) return fail('E_STATE_CORRUPT', 'sign');
  const existingSigned = await hashFile(signedPath);
  if (existingSigned && meta.signedSha256 === existingSigned && meta.signedTxid) {
    return {
      ok: true,
      txid: meta.signedTxid,
      recovered: meta.recovered,
      feeZat: meta.signedFeeZat,
      artifactSha256: existingSigned,
    };
  }
  if (!(await checkGateSocket(runtime.gateSocket))) return fail('E_SIGNER_UNAVAILABLE', 'sign');
  const result = await gateSubmit(paths, meta.approvalId, provenPath, signedPath);
  if (!result.ok) {
    await appendJobLog(dir, 'sign rejected', result.detail);
    return fail(result.code, result.stage);
  }
  if (meta.txid && meta.txid !== result.txid) {
    await appendJobLog(dir, 'txid mismatch', `${meta.txid} != ${result.txid}`);
    return fail('E_STATE_CORRUPT', 'sign');
  }
  const signedSha = await hashFile(signedPath);
  if (!signedSha) return fail('E_STATE_CORRUPT', 'sign');
  meta.signedSha256 = signedSha;
  meta.signedTxid = result.txid;
  meta.signedFeeZat = result.feeZat;
  meta.txid = result.txid;
  meta.recovered = result.recovered;
  await saveMeta(meta);
  return {
    ok: true,
    txid: result.txid,
    recovered: result.recovered,
    feeZat: result.feeZat,
    artifactSha256: signedSha,
  };
}

async function broadcast(jobId: string): Promise<Record<string, unknown>> {
  const dir = jobDir(jobId);
  const meta = await loadMeta(jobId);
  if (!meta) return fail('E_NOT_FOUND', 'broadcast');
  const signedPath = path.join(dir, 'signed.pczt');
  const signedSha = await hashFile(signedPath);
  if (!signedSha || !meta.signedSha256 || signedSha !== meta.signedSha256) {
    return fail('E_ARTIFACT_MISSING', 'broadcast');
  }
  const result = await broadcastArtifact(paths, signedPath);
  if (!result.ok) {
    await appendJobLog(dir, 'broadcast uncertain', result.detail);
    return { ...fail(result.code, 'broadcast', { uncertain: true }), txid: meta.signedTxid };
  }
  if (meta.signedTxid && meta.signedTxid !== result.txid) {
    await appendJobLog(dir, 'broadcast txid mismatch', `${meta.signedTxid} != ${result.txid}`);
    return fail('E_STATE_CORRUPT', 'broadcast');
  }
  return { ok: true, txid: result.txid };
}

async function status(txid: string): Promise<Record<string, unknown>> {
  const result = await walletTxStatus(paths, txid);
  if (!result.ok) {
    await logLine(`status failed ${result.code}`);
    return fail(result.code, result.stage, { retryable: true });
  }
  return {
    ok: true,
    found: result.found,
    minedHeight: result.minedHeight,
    syncedAt: result.syncedAt,
  };
}

async function health(): Promise<Record<string, unknown>> {
  const socketOk = await checkGateSocket(runtime.gateSocket);
  const lastSyncMs = workerState.lastSyncAt ? Date.parse(workerState.lastSyncAt) : NaN;
  const chainContext =
    Number.isFinite(lastSyncMs) && Date.now() - lastSyncMs <= runtime.syncIntervalSeconds * 1000
      ? 'fresh'
      : workerState.lastSyncAt
        ? 'stale'
        : 'unknown';
  const spendable = workerState.lastSpendableZat;
  const required = BigInt(trustedConfig.limits.maxAmountZat) + BigInt(trustedConfig.limits.maxFeeZat);
  const funding =
    spendable && isZatString(spendable)
      ? BigInt(spendable) >= required
        ? 'available'
        : 'insufficient'
      : 'unknown';
  return {
    ok: true,
    gateSocket: socketOk,
    lastSyncAt: workerState.lastSyncAt,
    lastTip: workerState.lastTip,
    chainContext,
    funding,
  };
}

async function refresh(): Promise<Record<string, unknown>> {
  const sync = await syncWallet(runtime.walletDir, runtime.devtoolBin, 150_000);
  if (!sync.ok) return fail(sync.code, sync.stage);
  const spendableValue = sync.balanceJson?.ironwood_spendable;
  const spendableZat =
    typeof spendableValue === 'string' || typeof spendableValue === 'number'
      ? String(spendableValue)
      : null;
  workerState = { lastSyncAt: nowIso(), lastTip: sync.tip, lastSpendableZat: spendableZat };
  await saveState();
  return health();
}

async function handle(request: WorkerRequest): Promise<Record<string, unknown>> {
  const cmd = request.cmd;
  if (typeof cmd !== 'string') return fail('E_BAD_REQUEST', 'worker');
  if (cmd === 'health') return health();
  if (cmd === 'sync') return jobMutex.runExclusive(() => refresh());
  const jobId = jobIdFrom(request.jobId);
  if (!jobId) return fail('E_BAD_REQUEST', 'worker');

  if (cmd === 'build') {
    const approvalId = request.approvalId;
    const scenario = request.scenario;
    if (typeof approvalId !== 'string' || !isSafeId(approvalId)) {
      return fail('E_BAD_REQUEST', 'build');
    }
    if (scenario !== 'matching' && scenario !== 'changed-recipient' && scenario !== 'hidden-memo') {
      return scenario === 'excess-fee' || scenario === 'forged-approval'
        ? fail('E_UNAVAILABLE_SCENARIO', 'build')
        : fail('E_SCENARIO_NOT_ALLOWED', 'build');
    }
    return jobMutex.runExclusive(() => build(jobId, approvalId, scenario));
  }

  if (cmd === 'prove') return jobMutex.runExclusive(() => prove(jobId));
  if (cmd === 'sign') return jobMutex.runExclusive(() => sign(jobId));
  if (cmd === 'broadcast') return jobMutex.runExclusive(() => broadcast(jobId));
  if (cmd === 'status') {
    const txid = request.txid;
    if (!isHex64(txid)) return fail('E_BAD_REQUEST', 'status');
    return jobMutex.runExclusive(() => status(txid));
  }
  return fail('E_BAD_REQUEST', 'worker');
}

function startServer(): void {
  try {
    // Best-effort removal of a stale socket; never remove a live one by accident.
    const stat = statSync(runtime.socketPath, { throwIfNoEntry: false });
    if (stat) unlinkSync(runtime.socketPath);
  } catch {
    // ignore
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), 600_000);
    socket.on('error', () => {
      clearTimeout(timer);
    });
    socket.on('close', () => clearTimeout(timer));
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 128 * 1024) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      const line = buffer.slice(0, newline);
      let request: WorkerRequest;
      try {
        request = JSON.parse(line) as WorkerRequest;
      } catch {
        socket.end(`${JSON.stringify(fail('E_BAD_REQUEST', 'worker'))}\n`);
        return;
      }
      handle(request)
        .then((response) => {
          socket.end(`${JSON.stringify(response)}\n`);
        })
        .catch((error: unknown) => {
          logLine(`worker internal: ${(error as Error).message}`);
          socket.end(`${JSON.stringify(fail('E_WORKER_INTERNAL', 'worker'))}\n`);
        });
    });
  });
  server.listen(runtime.socketPath, () => {
    void fs.chmod(runtime.socketPath, 0o600).catch(() => undefined);
    logLine(`worker listening on ${runtime.socketPath}`);
  });
  server.on('error', (error) => {
    logLine(`worker server error: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  await ensureDir(runtime.spoolDir, 0o700);
  await loadState();
  const config = await readJson<TrustedWorkerConfig>(runtime.workerConfigPath);
  if (!config) throw new Error('trusted worker config is missing');
  trustedConfig = config;
  validateWorkerConfig(trustedConfig);
  startServer();
}

void main().catch((error: unknown) => {
  logLine(`worker startup failed: ${(error as Error).message}`);
  process.exit(1);
});
