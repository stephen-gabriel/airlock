import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../apps/web');

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/live.css', { file: 'live.css', type: 'text/css; charset=utf-8' }],
  ['/app-live.js', { file: 'app-live.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app-live.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/airlock-mark.svg', { file: 'assets/airlock-mark.svg', type: 'image/svg+xml' }],
]);

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': [
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
    'X-Airlock-Fixture': 'test-only',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, {
    mode: 'live-testnet',
    requestId: 'fixture-request',
    error: { code, message, stage: 'fixture', retryable: false },
  });
}

async function sendStatic(res, entry) {
  let body = await fs.readFile(path.join(webRoot, entry.file));
  if (entry.file === 'index.html') {
    const marker = '<div role="note" aria-label="Test fixture only" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#7a1f1f;color:#fff;font:600 10px/1.4 system-ui,sans-serif;padding:4px 7px;border-radius:3px;pointer-events:none">TEST FIXTURE - NOT LIVE</div>';
    body = Buffer.from(
      String(body)
        .replace('<title>', '<title>[TEST FIXTURE] ')
        .replace('<body>', `<body>${marker}`),
    );
  }
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': entry.type,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function probeTestGate(gateUrl) {
  if (!gateUrl) return 'not-configured';
  try {
    const response = await fetch(gateUrl, { signal: AbortSignal.timeout(500) });
    return response.ok ? 'reachable' : 'unhealthy';
  } catch {
    return 'disconnected';
  }
}

export async function createFixtureServer({ scenario, gateUrl = null }) {
  const fixture = buildFixture(scenario);
  let gateProbe = scenario === 'gate-unavailable' ? 'not-probed' : 'not-applicable';
  let gateProbeAt = null;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if (pathname === '/__fixture/meta') {
        sendJson(res, 200, {
          testOnly: true,
          scenario,
          fixtureVersion: fixture.fixtureVersion,
          description: fixture.description,
          gateProbe,
          gateProbeAt,
          liveServicesTouched: false,
          setM1cTouched: false,
          realBroadcast: false,
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (method !== 'GET') {
          req.resume();
          sendError(res, 403, 'E_FIXTURE_READ_ONLY', 'The fixture server is read-only.');
          return;
        }

        if (pathname === '/api/health') {
          if (scenario === 'gate-unavailable') {
            gateProbe = await probeTestGate(gateUrl);
            gateProbeAt = new Date().toISOString();
          }
          sendJson(res, 200, fixture.health);
          return;
        }

        if (pathname === '/api/session') {
          sendJson(res, 200, fixture.session);
          return;
        }

        if (pathname === '/api/approvals') {
          sendJson(res, 200, { mode: 'live-testnet', approvals: fixture.session.approvals });
          return;
        }

        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approvalMatch) {
          const approval = fixture.session.approvals.find((value) => value.id === approvalMatch[1]);
          if (!approval) sendError(res, 404, 'E_NOT_FOUND', 'Fixture approval not found.');
          else sendJson(res, 200, { mode: 'live-testnet', approval });
          return;
        }

        if (pathname === '/api/jobs') {
          sendJson(res, 200, { mode: 'live-testnet', jobs: fixture.jobs });
          return;
        }

        const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const job = fixture.jobs.find((value) => value.id === jobMatch[1]);
          if (!job) sendError(res, 404, 'E_NOT_FOUND', 'Fixture job not found.');
          else sendJson(res, 200, { mode: 'live-testnet', job });
          return;
        }

        if (pathname === '/api/receipts') {
          sendJson(res, 200, { mode: 'live-testnet', receipts: fixture.receipts });
          return;
        }

        const receiptMatch = pathname.match(/^\/api\/receipts\/([^/]+)$/);
        if (receiptMatch) {
          const receipt = fixture.receipts.find((value) => value.id === receiptMatch[1]);
          if (!receipt) sendError(res, 404, 'E_NOT_FOUND', 'Fixture receipt not found.');
          else sendJson(res, 200, { mode: 'live-testnet', receipt });
          return;
        }

        sendError(res, 404, 'E_NOT_FOUND', 'Fixture route not found.');
        return;
      }

      if (method !== 'GET') {
        res.writeHead(405, { ...securityHeaders(), Allow: 'GET' });
        res.end();
        return;
      }

      const entry = staticFiles.get(pathname);
      if (!entry) {
        res.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      await sendStatic(res, entry);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Fixture server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fixture server did not expose a TCP port.');
  }

  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    fixture,
    meta: () => ({
      testOnly: true,
      scenario,
      fixtureVersion: fixture.fixtureVersion,
      description: fixture.description,
      gateProbe,
      gateProbeAt,
      liveServicesTouched: false,
      setM1cTouched: false,
      realBroadcast: false,
    }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
