import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Approval,
  ErrorResponse,
  SafeError,
  Scenario,
} from '../../../packages/contracts/api.js';
import { loadApiConfig } from './config.js';
import { JobService, publicJob, publicReceipt, publicSession } from './jobs.js';
import { clientError, safeMessage } from './errors.js';
import type { InventoryApproval, SessionRecord, Store } from './store.js';
import { Store as StoreClass } from './store.js';
import { assertPathInside, isSafeId, randomHex, sha256Hex } from './util.js';

const SESSION_COOKIE = 'airlock_session';
const MAX_IDEMPOTENCY_KEY = 200;

const config = loadApiConfig();
const store = new StoreClass(config.stateDir);
const jobs = new JobService(config, store);
const cookieSecure =
  config.cookieSecure || Boolean(config.publicOrigin?.startsWith('https://'));

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  if (cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendError(
  res: ServerResponse,
  requestId: string,
  error: SafeError,
  status: number,
  jobId?: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body: ErrorResponse = {
    mode: 'live-testnet',
    requestId,
    error,
    ...(jobId ? { jobId } : {}),
  };
  sendJson(res, status, body);
}

function isSafeErrorLike(value: unknown): value is SafeError {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    typeof record.message === 'string' &&
    typeof record.stage === 'string' &&
    typeof record.retryable === 'boolean'
  );
}

function statusFor(code: string): number {
  const values: Record<string, number> = {
    E_NOT_FOUND: 404,
    E_NO_SESSION: 401,
    E_ORIGIN: 403,
    E_METHOD: 405,
    E_BAD_REQUEST: 400,
    E_BODY_TOO_LARGE: 413,
    E_RATE_LIMITED: 429,
    E_DEMO_EXHAUSTED: 409,
    E_APPROVAL_CONSUMED: 409,
    E_APPROVAL_EXPIRED: 410,
    E_IDEMPOTENCY_CONFLICT: 409,
    E_SCENARIO_NOT_ALLOWED: 409,
    E_UNAVAILABLE_SCENARIO: 422,
    E_AUTH_IN_USE: 409,
    E_WORKER_UNAVAILABLE: 503,
    E_SIGNER_UNAVAILABLE: 503,
    E_STATUS_UNAVAILABLE: 503,
    E_TIMEOUT: 504,
    E_INTERNAL: 500,
    E_WORKER_INTERNAL: 500,
  };
  return values[code] ?? (code.startsWith('E_') ? 400 : 500);
}

function methodNotAllowed(res: ServerResponse, allow: string): never {
  res.setHeader('Allow', allow);
  throw clientError('E_METHOD', 'request', false);
}

function getCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(
    0,
    Math.floor(maxAgeSeconds),
  )}${cookieSecure ? '; Secure' : ''}`;
}

function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const loopback =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote.endsWith('127.0.0.1');
  if (loopback) {
    const forwarded =
      req.headers['cf-connecting-ip'] ??
      req.headers['x-real-ip'] ??
      req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0]?.trim();
      if (first && first.length <= 100) return first;
    }
  }
  return remote;
}

function assertOrigin(req: IncomingMessage): void {
  if (req.method !== 'POST') return;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw clientError('E_ORIGIN', 'request', false);
  }
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = new Set<string>([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  if (config.publicOrigin) {
    try {
      allowed.add(new URL(config.publicOrigin).origin);
    } catch {
      // Invalid configuration is reported at startup; do not widen failures.
    }
  }
  const host = req.headers.host;
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  if (!allowed.has(origin)) throw clientError('E_ORIGIN', 'request', false);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw clientError('E_BAD_REQUEST', 'request', false, 'Expected application/json.');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > config.requestBodyLimit) {
    throw clientError('E_BODY_TOO_LARGE', 'request', false);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > config.requestBodyLimit) {
      throw clientError('E_BODY_TOO_LARGE', 'request', false);
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw clientError('E_BAD_REQUEST', 'request', false, 'Malformed JSON body.');
  }
}

async function requireSession(req: IncomingMessage): Promise<SessionRecord> {
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw) throw clientError('E_NO_SESSION', 'session', false);
  const sessionId = store.parseSessionCookieValue(raw);
  if (!sessionId) throw clientError('E_NO_SESSION', 'session', false);
  const session = await store.getSession(sessionId);
  if (!session) throw clientError('E_NO_SESSION', 'session', false);
  return session;
}

function publicApproval(approval: InventoryApproval): Approval {
  const { role: _role, ...rest } = approval;
  return rest;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw clientError('E_BAD_REQUEST', 'request', false);
  }
  return value as Record<string, unknown>;
}

function requireScenario(value: unknown): Scenario {
  if (
    value !== 'matching' &&
    value !== 'changed-recipient' &&
    value !== 'hidden-memo' &&
    value !== 'excess-fee' &&
    value !== 'forged-approval'
  ) {
    throw clientError('E_BAD_REQUEST', 'request', false);
  }
  return value;
}

async function createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  assertOrigin(req);
  req.resume();
  const existingRaw = getCookie(req, SESSION_COOKIE);
  if (existingRaw) {
    const sessionId = store.parseSessionCookieValue(existingRaw);
    const existing = sessionId ? await store.getSession(sessionId) : null;
    if (existing) {
      setSessionCookie(res, existing);
      sendJson(res, 200, {
        ...publicSession(existing),
        approvals: await store.getApprovalsForSession(existing),
      });
      return;
    }
  }
  const session = await store.allocateSession(store.hashIp(clientIp(req)), {
    perIp: config.perIpSessionLimit,
    global: config.globalSessionLimit,
    ttlSeconds: config.sessionTtlSeconds,
  });
  setSessionCookie(res, session);
  sendJson(res, 201, {
    ...publicSession(session),
    approvals: await store.getApprovalsForSession(session),
  });
}

function setSessionCookie(res: ServerResponse, session: SessionRecord): void {
  const seconds = (Date.parse(session.expiresAt) - Date.now()) / 1000;
  res.setHeader('Set-Cookie', sessionCookie(store.makeSessionCookieValue(session.sessionId), seconds));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (pathname === '/api/health') {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    sendJson(res, 200, await jobs.health());
    return;
  }

  if (pathname === '/api/demo/sessions') {
    if (method !== 'POST') methodNotAllowed(res, 'POST');
    await createSession(req, res);
    return;
  }

  if (pathname === '/api/session') {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const session = await requireSession(req);
    sendJson(res, 200, {
      ...publicSession(session),
      approvals: await store.getApprovalsForSession(session),
    });
    return;
  }

  if (pathname === '/api/approvals') {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const session = await requireSession(req);
    const approvals = await store.getApprovalsForSession(session);
    sendJson(res, 200, { mode: 'live-testnet', approvals });
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalMatch) {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const session = await requireSession(req);
    const approvalId = approvalMatch[1];
    if (!isSafeId(approvalId)) throw clientError('E_NOT_FOUND', 'approval', false);
    const approval = await store.findApproval(session, approvalId);
    if (!approval) throw clientError('E_NOT_FOUND', 'approval', false);
    sendJson(res, 200, { mode: 'live-testnet', approval: publicApproval(approval) });
    return;
  }

  if (pathname === '/api/jobs') {
    const session = await requireSession(req);
    if (method === 'GET') {
      const list = await store.listJobs(session.sessionId);
      sendJson(res, 200, { mode: 'live-testnet', jobs: list.map(publicJob) });
      return;
    }
    if (method !== 'POST') methodNotAllowed(res, 'GET, POST');
    assertOrigin(req);
    const key = req.headers['idempotency-key'];
    if (
      typeof key !== 'string' ||
      key.length < 1 ||
      key.length > MAX_IDEMPOTENCY_KEY ||
      /[\r\n]/.test(key)
    ) {
      throw clientError('E_BAD_REQUEST', 'job', false, 'A valid Idempotency-Key header is required.');
    }
    const body = requireObject(await readJsonBody(req));
    if (typeof body.approvalId !== 'string' || !isSafeId(body.approvalId)) {
      throw clientError('E_BAD_REQUEST', 'job', false);
    }
    const scenario = requireScenario(body.scenario);
    const job = await jobs.createJob(
      session,
      body.approvalId,
      scenario,
      key,
      sha256Hex(`${body.approvalId}\u0000${scenario}`),
    );
    res.setHeader('Location', `/api/jobs/${job.id}`);
    sendJson(res, 202, { mode: 'live-testnet', jobId: job.id, job: publicJob(job) });
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const session = await requireSession(req);
    const jobId = jobMatch[1];
    if (!isSafeId(jobId)) throw clientError('E_NOT_FOUND', 'job', false);
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const job = await store.getJob(jobId);
    if (!job || job.sessionId !== session.sessionId) {
      throw clientError('E_NOT_FOUND', 'job', false);
    }
    sendJson(res, 200, { mode: 'live-testnet', job: publicJob(job) });
    return;
  }

  const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (resumeMatch) {
    if (method !== 'POST') methodNotAllowed(res, 'POST');
    assertOrigin(req);
    req.resume();
    const session = await requireSession(req);
    const jobId = resumeMatch[1];
    if (!isSafeId(jobId)) throw clientError('E_NOT_FOUND', 'job', false);
    const job = await jobs.resume(jobId, session);
    sendJson(res, 202, { mode: 'live-testnet', job: publicJob(job) });
    return;
  }

  const broadcastMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/broadcast$/);
  if (broadcastMatch) {
    if (method !== 'POST') methodNotAllowed(res, 'POST');
    assertOrigin(req);
    req.resume();
    const session = await requireSession(req);
    const jobId = broadcastMatch[1];
    if (!isSafeId(jobId)) throw clientError('E_NOT_FOUND', 'job', false);
    const job = await jobs.broadcast(jobId, session);
    sendJson(res, 200, { mode: 'live-testnet', job: publicJob(job) });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (statusMatch) {
    if (method !== 'POST') methodNotAllowed(res, 'POST');
    assertOrigin(req);
    req.resume();
    const session = await requireSession(req);
    const jobId = statusMatch[1];
    if (!isSafeId(jobId)) throw clientError('E_NOT_FOUND', 'job', false);
    const job = await jobs.refreshStatus(jobId, session, true);
    sendJson(res, 200, { mode: 'live-testnet', job: publicJob(job) });
    return;
  }

  if (pathname === '/api/receipts') {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const session = await requireSession(req);
    const receipts = await store.listReceipts(session.sessionId);
    sendJson(res, 200, { mode: 'live-testnet', receipts: receipts.map(publicReceipt) });
    return;
  }

  const receiptMatch = pathname.match(/^\/api\/receipts\/([^/]+)$/);
  if (receiptMatch) {
    if (method !== 'GET') methodNotAllowed(res, 'GET');
    const session = await requireSession(req);
    const receiptId = receiptMatch[1];
    if (!isSafeId(receiptId)) throw clientError('E_NOT_FOUND', 'receipt', false);
    const receipt = await store.getReceipt(receiptId);
    if (!receipt || receipt.sessionId !== session.sessionId) {
      throw clientError('E_NOT_FOUND', 'receipt', false);
    }
    sendJson(res, 200, { mode: 'live-testnet', receipt: publicReceipt(receipt) });
    return;
  }

  throw clientError('E_NOT_FOUND', 'request', false);
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app-live.js', type: 'text/javascript; charset=utf-8' },
  '/app-live.js': { file: 'app-live.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/live.css': { file: 'live.css', type: 'text/css; charset=utf-8' },
};

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const values: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
  };
  return values[ext] ?? 'application/octet-stream';
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') methodNotAllowed(res, 'GET, HEAD');
  let mapping = STATIC_FILES[pathname];
  if (!mapping && pathname.startsWith('/assets/')) {
    if (!/^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)) {
      throw clientError('E_NOT_FOUND', 'static', false);
    }
    const file = pathname.slice(1);
    mapping = { file, type: contentTypeFor(file) };
  }
  if (!mapping) throw clientError('E_NOT_FOUND', 'static', false);
  const resolved = path.resolve(config.webDir, mapping.file);
  assertPathInside(config.webDir, resolved);
  let value: Buffer;
  try {
    value = await fs.readFile(resolved);
  } catch {
    throw clientError('E_NOT_FOUND', 'static', false);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', mapping.type);
  res.setHeader('Content-Length', value.length);
  res.setHeader('Cache-Control', pathname === '/' || pathname.endsWith('.html') ? 'no-store' : 'no-cache');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(value);
}

function logLine(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const requestId = randomHex(8);
  let pathname = '/';
  setSecurityHeaders(res);
  res.setHeader('X-Request-Id', requestId);
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (error) {
    if (isSafeErrorLike(error)) {
      sendError(res, requestId, error, statusFor(error.code));
    } else {
      logLine(
        `request ${requestId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      sendError(
        res,
        requestId,
        {
          code: 'E_INTERNAL',
          message: safeMessage('E_INTERNAL'),
          stage: 'server',
          retryable: false,
        },
        500,
      );
    }
  } finally {
    res.on('finish', () => {
      logLine(
        `${requestId} ${req.method ?? '?'} ${pathname} ${res.statusCode} ${Date.now() - started}ms`,
      );
    });
  }
}

async function main(): Promise<void> {
  await store.init();
  await jobs.init();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('error', (error) => {
    logLine(`server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    logLine(`airlock api listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (): void => {
    logLine('shutting down');
    jobs.stop();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    logLine(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

void main().catch((error: unknown) => {
  logLine(`startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
