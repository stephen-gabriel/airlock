import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const webDir = path.join(repoRoot, 'apps', 'web');
const apiEntry = path.join(apiRoot, 'dist', 'apps', 'api', 'src', 'main.js');
const txid = '11'.repeat(32);
const otherTxid = '22'.repeat(32);
const blockedApproval = 'approval-blocked';

let tmpDir;
let stateDir;
let socketPath;
let api;
let baseUrl;
let fakeWorker;
let apiLogs = '';
let statusFound = false;
let minedHeight = null;
let broadcastUnknown = false;
let buildFailuresRemaining = 0;
let firstSession;
let secondSession;
let mainJobId;

function json(value) {
  return JSON.stringify(value);
}

function report(overrides = {}) {
  return {
    txid,
    recipientUa: 'utest1recipient',
    amountZat: '100000',
    memoDisplay: 'Airlock live demo',
    feeZat: null,
    expiryHeight: null,
    artifactSha256: 'bb'.repeat(32),
    source: 'trusted-builder',
    ...overrides,
  };
}

function approval(id, scenario, extra = {}) {
  return {
    id,
    network: 'testnet',
    recipientLabel: 'Demo recipient',
    recipientUa: 'utest1recipient',
    amountZat: '100000',
    maxFeeZat: '10000',
    memo: { display: 'Airlock live demo', encoding: 'canonical-512', policy: 'exact' },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'pending',
    singlePayment: true,
    boundTxid: null,
    scenario,
    role: scenario,
    ...extra,
  };
}

function inventory() {
  return {
    version: 1,
    network: 'testnet',
    updatedAt: new Date().toISOString(),
    sets: [
      {
        id: 'set-a',
        status: 'available',
        sessionId: null,
        assignedAt: null,
        createdAt: new Date().toISOString(),
        approvals: [approval('approval-match', 'matching')],
      },
      {
        id: 'set-b',
        status: 'available',
        sessionId: null,
        assignedAt: null,
        createdAt: new Date().toISOString(),
        approvals: [approval(blockedApproval, 'matching')],
      },
      {
        id: 'set-c',
        status: 'available',
        sessionId: null,
        assignedAt: null,
        createdAt: new Date().toISOString(),
        approvals: [approval('approval-extra', 'matching')],
      },
    ],
  };
}

function startFakeWorker() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.end(`${json({ ok: false, code: 'E_BAD_REQUEST', stage: 'worker', message: 'bad' })}\n`);
          return;
        }
        const response = handleWorker(request);
        socket.end(`${json(response)}\n`);
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function handleWorker(request) {
  if (request.cmd === 'health') {
    return {
      ok: true,
      gateSocket: true,
      lastSyncAt: new Date().toISOString(),
      lastTip: 1234,
      chainContext: 'fresh',
      funding: 'available',
    };
  }
  if (request.cmd === 'build') {
    if (request.approvalId === blockedApproval && buildFailuresRemaining > 0) {
      buildFailuresRemaining -= 1;
      return {
        ok: false,
        code: 'E_WORKER_UNAVAILABLE',
        stage: 'build',
        message: 'synthetic worker outage',
        retryable: true,
      };
    }
    return { ok: true, report: report() };
  }
  if (request.cmd === 'prove') {
    return { ok: true, report: report({ artifactSha256: 'bb'.repeat(32) }) };
  }
  if (request.cmd === 'sign') {
    return {
      ok: true,
      txid,
      recovered: false,
      feeZat: '1000',
      artifactSha256: 'cc'.repeat(32),
    };
  }
  if (request.cmd === 'broadcast') {
    if (broadcastUnknown) {
      return {
        ok: false,
        code: 'E_BROADCAST_UNKNOWN',
        stage: 'broadcast',
        message: 'synthetic uncertain broadcast',
        retryable: true,
      };
    }
    return { ok: true, txid };
  }
  if (request.cmd === 'status') {
    return {
      ok: true,
      found: statusFound,
      minedHeight: statusFound ? minedHeight : null,
      syncedAt: new Date().toISOString(),
    };
  }
  return { ok: false, code: 'E_BAD_REQUEST', stage: 'worker', message: 'unknown command' };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited: ${apiLogs}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API health timeout: ${apiLogs}`);
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : json(options.body),
  });
  let body = null;
  let text = null;
  if (options.raw) {
    text = await response.text();
  } else {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  const cookie = response.headers.get('set-cookie')?.split(';')[0] || null;
  return { response, status: response.status, body, text, cookie };
}

async function createSession() {
  const result = await request('/api/demo/sessions', { method: 'POST' });
  assert.equal(result.status, 201);
  assert.ok(result.cookie && result.cookie.startsWith('airlock_session='));
  return result;
}

async function waitForJob(cookie, jobId, states) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await request(`/api/jobs/${jobId}`, { cookie });
    assert.equal(result.status, 200);
    if (states.includes(result.body.job.state)) return result.body.job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not reach ${states.join(', ')}`);
}

async function createJob(cookie, approvalId, scenario, key) {
  return request('/api/jobs', {
    method: 'POST',
    cookie,
    headers: { 'Idempotency-Key': key },
    body: { approvalId, scenario },
  });
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airlock-m2-'));
  stateDir = path.join(tmpDir, 'state');
  socketPath = path.join(tmpDir, 'worker.sock');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'inventory.json'), json(inventory()));
  fakeWorker = await startFakeWorker();
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AIRLOCK_API_STATE: stateDir,
    AIRLOCK_WEB_DIR: webDir,
    AIRLOCK_WORKER_SOCKET: socketPath,
    AIRLOCK_API_HOST: '127.0.0.1',
    AIRLOCK_API_PORT: String(port),
    AIRLOCK_COOKIE_SECURE: '0',
    AIRLOCK_SESSION_TTL_SECONDS: '300',
    AIRLOCK_PER_IP_SESSION_LIMIT: '2',
    AIRLOCK_GLOBAL_SESSION_LIMIT: '2',
    AIRLOCK_PUBLIC_ORIGIN: '',
  };
  api = spawn(process.execPath, [apiEntry], { cwd: apiRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => {
    apiLogs += chunk.toString();
  });
  api.stderr.on('data', (chunk) => {
    apiLogs += chunk.toString();
  });
  await waitForHealth();
}, { timeout: 30_000 });

after(async () => {
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      api.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (fakeWorker) await new Promise((resolve) => fakeWorker.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

test('M2 health exposes quota and funding truthfully', async () => {
  const result = await request('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ready');
  assert.equal(result.body.signer, 'available');
  assert.equal(result.body.funding, 'available');
  assert.equal(result.body.demoSetsRemaining, 3);
  assert.equal(result.body.sessionSlotsRemaining, 2);
  assert.equal(result.body.acceptingDemoSessions, true);
});

test('session isolation, idempotency, and unsupported scenarios', async () => {
  const first = await createSession();
  firstSession = first;
  const firstAgain = await request('/api/demo/sessions', {
    method: 'POST',
    cookie: first.cookie,
  });
  assert.equal(firstAgain.status, 200);
  assert.equal(firstAgain.body.sessionId, first.body.sessionId);

  const second = await createSession();
  secondSession = second;
  assert.notEqual(second.body.sessionId, first.body.sessionId);
  assert.deepEqual(
    first.body.approvals.map((value) => value.id),
    ['approval-match'],
  );
  assert.deepEqual(
    second.body.approvals.map((value) => value.id),
    [blockedApproval],
  );

  const job = await createJob(first.cookie, 'approval-match', 'matching', 'idem-1');
  assert.equal(job.status, 202);
  const jobId = job.body.job.id;
  mainJobId = jobId;

  const repeated = await createJob(first.cookie, 'approval-match', 'matching', 'idem-1');
  assert.equal(repeated.status, 202);
  assert.equal(repeated.body.job.id, jobId);

  const conflict = await createJob(first.cookie, 'approval-match', 'changed-recipient', 'idem-1');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'E_IDEMPOTENCY_CONFLICT');

  const unsupported = await createJob(first.cookie, 'approval-match', 'excess-fee', 'idem-2');
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.error.code, 'E_UNAVAILABLE_SCENARIO');

  const missingKey = await request('/api/jobs', {
    method: 'POST',
    cookie: first.cookie,
    body: { approvalId: 'approval-match', scenario: 'matching' },
  });
  assert.equal(missingKey.status, 400);

  const badOrigin = await request('/api/jobs', {
    method: 'POST',
    cookie: first.cookie,
    headers: { 'Idempotency-Key': 'idem-origin', origin: 'https://evil.example' },
    body: { approvalId: 'approval-match', scenario: 'matching' },
  });
  assert.equal(badOrigin.status, 403);

  const crossSessionJob = await request(`/api/jobs/${jobId}`, { cookie: second.cookie });
  assert.equal(crossSessionJob.status, 404);
  const crossSessionApproval = await request('/api/approvals/approval-match', {
    cookie: second.cookie,
  });
  assert.equal(crossSessionApproval.status, 404);

  const signed = await waitForJob(first.cookie, jobId, ['signed']);
  assert.equal(signed.checks.every((value) => value.status === 'match'), true);
  const session = await request('/api/session', { cookie: first.cookie });
  assert.equal(session.body.approvals[0].status, 'completed');
});

test('broadcast unknown reconciles before exact-artifact retry', async () => {
  const signed = await request(`/api/jobs/${mainJobId}`, { cookie: firstSession.cookie });
  assert.equal(signed.body.job.state, 'signed');

  broadcastUnknown = true;
  const unknown = await request(`/api/jobs/${mainJobId}/broadcast`, {
    method: 'POST',
    cookie: firstSession.cookie,
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.job.state, 'broadcast_unknown');
  assert.equal(unknown.body.job.broadcastAttempts, 1);
  assert.equal(unknown.body.job.error.code, 'E_BROADCAST_UNKNOWN');

  const receiptsAfterUnknown = await request('/api/receipts', { cookie: firstSession.cookie });
  assert.equal(receiptsAfterUnknown.body.receipts[0].networkStatus, 'unknown');

  const crossBroadcast = await request(`/api/jobs/${mainJobId}/broadcast`, {
    method: 'POST',
    cookie: secondSession.cookie,
  });
  assert.equal(crossBroadcast.status, 404);
  const crossStatus = await request(`/api/jobs/${mainJobId}/status`, {
    method: 'POST',
    cookie: secondSession.cookie,
  });
  assert.equal(crossStatus.status, 404);

  broadcastUnknown = false;
  statusFound = false;
  const retry = await request(`/api/jobs/${mainJobId}/broadcast`, {
    method: 'POST',
    cookie: firstSession.cookie,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.job.state, 'pending');
  assert.equal(retry.body.job.broadcastAttempts, 2);
  assert.equal(retry.body.job.txid, txid);

  const receiptsAfterRetry = await request('/api/receipts', { cookie: firstSession.cookie });
  assert.equal(receiptsAfterRetry.body.receipts[0].networkStatus, 'pending');

  statusFound = true;
  minedHeight = 125;
  const confirmed = await request(`/api/jobs/${mainJobId}/status`, {
    method: 'POST',
    cookie: firstSession.cookie,
  });
  assert.equal(confirmed.body.job.state, 'confirmed');
  assert.equal(confirmed.body.job.minedHeight, 125);

  const receipt = await request(
    `/api/receipts/${receiptsAfterRetry.body.receipts[0].id}`,
    { cookie: firstSession.cookie },
  );
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.receipt.networkStatus, 'confirmed');
  assert.equal(receipt.body.receipt.minedHeight, 125);
  assert.equal(receipt.body.receipt.txid, txid);
  const otherReceipt = await request(
    `/api/receipts/${receiptsAfterRetry.body.receipts[0].id}`,
    { cookie: secondSession.cookie },
  );
  assert.equal(otherReceipt.status, 404);
});

test('blocked job resumes in place without a new job or payment', async () => {
  buildFailuresRemaining = 1;
  const created = await createJob(secondSession.cookie, blockedApproval, 'matching', 'idem-block');
  assert.equal(created.status, 202);
  const jobId = created.body.job.id;
  const blocked = await waitForJob(secondSession.cookie, jobId, ['blocked']);
  assert.equal(blocked.error.code, 'E_WORKER_UNAVAILABLE');
  assert.equal(blocked.error.retryable, true);

  const crossResume = await request(`/api/jobs/${jobId}/resume`, {
    method: 'POST',
    cookie: firstSession.cookie,
  });
  assert.equal(crossResume.status, 404);

  const resumed = await request(`/api/jobs/${jobId}/resume`, {
    method: 'POST',
    cookie: secondSession.cookie,
  });
  assert.equal(resumed.status, 202);
  assert.equal(resumed.body.job.id, jobId);
  assert.equal(resumed.body.job.state, 'queued');

  const signed = await waitForJob(secondSession.cookie, jobId, ['signed']);
  assert.equal(signed.txid, txid);
  const session = await request('/api/session', { cookie: secondSession.cookie });
  assert.equal(session.body.approvals[0].status, 'completed');
  const jobs = await request('/api/jobs', { cookie: secondSession.cookie });
  assert.equal(jobs.body.jobs.length, 1);
  assert.equal(jobs.body.jobs[0].id, jobId);

  const again = await request(`/api/jobs/${jobId}/resume`, {
    method: 'POST',
    cookie: secondSession.cookie,
  });
  assert.equal(again.status, 400);
});

test('quota, cookie boundaries, and static contracts stay truthful', async () => {
  const third = await request('/api/demo/sessions', { method: 'POST' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'E_RATE_LIMITED');

  const health = await request('/api/health');
  assert.equal(health.body.demoSetsRemaining, 1);
  assert.equal(health.body.sessionSlotsRemaining, 0);
  assert.equal(health.body.acceptingDemoSessions, false);
  assert.equal(health.body.status, 'degraded');
  assert.equal(health.body.reason, 'demo session quota is exhausted');

  const tampered = firstSession.cookie.slice(0, -1) + (firstSession.cookie.endsWith('0') ? '1' : '0');
  const rejected = await request('/api/session', { cookie: tampered });
  assert.equal(rejected.status, 401);
  const noSession = await request('/api/receipts');
  assert.equal(noSession.status, 401);

  const index = await request('/', { raw: true });
  assert.equal(index.status, 200);
  assert.match(index.text, /app-live\.js/);
  const app = await request('/app.js', { raw: true });
  assert.equal(app.status, 200);
  assert.match(app.response.headers.get('content-type') || '', /javascript/);
  assert.match(app.text, /function receiptsPage/);
  assert.match(app.response.headers.get('content-security-policy') || '', /default-src 'self'/);

  const missingApi = await request('/api/not-real');
  assert.equal(missingApi.status, 404);
  const missingStatic = await request('/not-real.txt');
  assert.equal(missingStatic.status, 404);
});
