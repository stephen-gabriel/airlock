import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from './server.mjs';
import { scenarioNames } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = process.env.AIRLOCK_FIXTURE_OUT
  ? path.resolve(process.env.AIRLOCK_FIXTURE_OUT)
  : path.join(here, 'artifacts');
const cdpPort = 9336;
const profile = path.join(os.tmpdir(), `airlock-m3-fixture-chrome-${process.pid}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

let chromePath = null;
for (const candidate of chromeCandidates) {
  try {
    await fs.access(candidate);
    chromePath = candidate;
    break;
  } catch {
    // Try the next installed browser path.
  }
}
if (!chromePath) {
  throw new Error('Chrome/Chromium not found; set CHROME_PATH to the browser executable.');
}

async function startTestGate() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test gate did not start');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

await fs.mkdir(outDir, { recursive: true });
await fs.rm(profile, { recursive: true, force: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

async function waitForDebug() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Chrome debug endpoint did not start');
}

await waitForDebug();
const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const waiters = new Map();
const browserErrors = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    browserErrors.push(message.params.args.map((value) => value.value || value.description || '').join(' '));
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !message.params.entry.text.includes('Failed to load resource')) {
    browserErrors.push(message.params.entry.text);
  }
  const list = waiters.get(message.method);
  if (list && list.length) list.shift()(message.params);
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function once(method, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const list = waiters.get(method) || [];
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    list.push((params) => {
      clearTimeout(timer);
      resolve(params);
    });
    waiters.set(method, list);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function setViewport(width, height, mobile = false, deviceScaleFactor = 1) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    mobile,
    deviceScaleFactor,
    screenWidth: width,
    screenHeight: height,
  });
}

async function waitReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(`(() => {
      const line = document.querySelector('.live-note')?.textContent || '';
      return Boolean(document.querySelector('[aria-current="page"]') && line && !line.includes('Connecting'));
    })()`);
    if (ready) return;
    await sleep(150);
  }
  throw new Error('fixture app did not render');
}

async function loadFixture(origin) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: `${origin}/` });
  await loaded;
  await waitReady();
  await sleep(700);
}

async function reloadFixture() {
  const loaded = once('Page.loadEventFired');
  await send('Page.reload', { ignoreCache: true });
  await loaded;
  await waitReady();
  await sleep(700);
}

async function navigate(page) {
  const current = await evaluate(`document.querySelector('[aria-current="page"]')?.getAttribute('data-page')`);
  if (current !== page) {
    await evaluate(`document.querySelector('.nav [data-page="${page}"]')?.click()`);
  }
  await sleep(700);
}

async function screenshot(file) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(outDir, file), Buffer.from(shot.data, 'base64'));
}

const auditExpression = `(() => {
  const vw = document.documentElement.clientWidth;
  const all = [...document.querySelectorAll('body *')];
  const desc = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    return el.tagName.toLowerCase() + id + cls + ' :: ' + text;
  };
  const visible = (el) => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  const offenders = all.filter((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.right > vw + 1 || r.left < -1;
  }).slice(0, 12).map((el) => {
    const r = el.getBoundingClientRect();
    return { selector: desc(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  });
  const interactive = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter(visible);
  const tooSmall = interactive.map((el) => {
    const r = el.getBoundingClientRect();
    return { selector: desc(el), width: Math.round(r.width), height: Math.round(r.height) };
  }).filter((item) => item.width < 24 || item.height < 24);
  const noLabel = interactive.filter((el) => {
    const text = (el.textContent || '').trim();
    return !text && !el.getAttribute('aria-label') && !el.getAttribute('title');
  }).map(desc);
  return {
    viewport: { width: vw, height: document.documentElement.clientHeight },
    overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw,
    offenders,
    tooSmall,
    noLabel,
    page: document.querySelector('[aria-current="page"]')?.textContent?.trim() || null,
    documentTitle: document.title,
    fixtureMarker: Boolean(document.querySelector('[aria-label="Test fixture only"]')),
    heading: document.querySelector('main h2, main h1')?.textContent?.trim() || null,
    healthLine: document.querySelector('.live-note')?.textContent?.trim() || null,
    gateLabel: document.querySelector('.top-actions .tag:not(.testnet)')?.textContent?.trim() || null,
    banner: document.querySelector('.demo-banner')?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 300) || null,
    emptyTitle: document.querySelector('.empty h2')?.textContent?.trim() || null,
    resultTitle: document.querySelector('.result h3')?.textContent?.trim() || null,
    statusPill: document.querySelector('.status-pill')?.textContent?.trim() || null,
    sessionLine: document.querySelector('.session-line')?.textContent?.trim().replace(/\\s+/g, ' ') || null,
    actions: [...document.querySelectorAll('.action-area button')].map((el) => ({
      label: el.textContent.trim().replace(/\\s+/g, ' '),
      action: el.getAttribute('data-action'),
      page: el.getAttribute('data-page'),
      disabled: Boolean(el.disabled),
    })),
    receiptTags: [...document.querySelectorAll('.receipt-list .tag, .receipt-item .tag')].map((el) => el.textContent.trim()),
    receiptDetail: document.querySelector('.receipt-details')?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 500) || null,
    bodyText: document.querySelector('main')?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 1600) || null,
  };
})()`;

async function audit(label) {
  return { label, ...(await evaluate(auditExpression)) };
}

function assert(checks, condition, message) {
  if (!condition) checks.push(message);
}

function auditIssues(checks, label, auditResult) {
  assert(checks, auditResult.fixtureMarker, `${label}: test fixture marker missing`);
  assert(checks, String(auditResult.documentTitle).startsWith('[TEST FIXTURE]'), `${label}: fixture title missing`);
  assert(checks, auditResult.overflowX === 0, `${label}: horizontal overflow ${auditResult.overflowX}`);
  assert(checks, auditResult.offenders.length === 0, `${label}: offscreen elements ${JSON.stringify(auditResult.offenders)}`);
  assert(checks, auditResult.tooSmall.length === 0, `${label}: undersized targets ${JSON.stringify(auditResult.tooSmall)}`);
  assert(checks, auditResult.noLabel.length === 0, `${label}: unlabeled controls ${JSON.stringify(auditResult.noLabel)}`);
}

const report = {
  capturedAt: new Date().toISOString(),
  testOnly: true,
  explicitlySeparatedFromRealIntegration: true,
  contract: 'packages/contracts/api.ts',
  fixtureFixtureVersion: 1,
  disclaimer: 'Synthetic UI fixtures. These checks do not prove signing, broadcast, mining, or recovery behavior. No real approval, demo set, payment, or live service was used.',
  scenarios: [],
  browserErrors,
  failures: [],
};
const checks = report.failures;

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');

  for (const scenario of scenarioNames) {
    const scenarioReport = { scenario, viewports: [], meta: null, gateStub: null };
    let gateStub = null;
    let gateUrl = null;
    if (scenario === 'gate-unavailable') {
      gateStub = await startTestGate();
      gateUrl = `${gateStub.origin}/health`;
      const reachable = await fetch(gateUrl).then((response) => response.ok).catch(() => false);
      await gateStub.close();
      scenarioReport.gateStub = {
        started: true,
        reachableBeforeDisconnect: reachable,
        closedBeforeUiLoad: true,
        onlyTestEndpointDisconnected: true,
        endpoint: gateUrl,
      };
      gateStub = null;
      assert(checks, reachable, 'gate-unavailable: test gate was not reachable before disconnect');
    }

    const fixtureServer = await createFixtureServer({ scenario, gateUrl });
    try {
      await setViewport(1440, 1000, false, 1);
      await loadFixture(fixtureServer.origin);
      const desktopWorkspace = await audit('desktop-workspace');
      await screenshot(`fixture-${scenario}-1440-workspace.png`);
      const desktopPages = { workspace: desktopWorkspace };

      if (scenario === 'no-approvals') {
        await navigate('approvals');
        desktopPages.approvals = await audit('desktop-approvals');
      } else if (scenario === 'no-funds') {
        await navigate('approvals');
        desktopPages.approvals = await audit('desktop-approvals');
      } else if (scenario !== 'gate-unavailable') {
        await navigate('receipts');
        desktopPages.receipts = await audit('desktop-receipts');
        await screenshot(`fixture-${scenario}-1440-receipts.png`);
        const hasDetail = await evaluate(`Boolean(document.querySelector('[data-action="view-receipt"]'))`);
        if (hasDetail) {
          await evaluate(`document.querySelector('[data-action="view-receipt"]').click()`);
          await sleep(400);
          desktopPages.receiptDetail = await audit('desktop-receipt-detail');
          await screenshot(`fixture-${scenario}-1440-receipt-detail.png`);
        }
      }

      await setViewport(320, 740, true, 1);
      await reloadFixture();
      const mobileWorkspace = await audit('mobile-workspace');
      await screenshot(`fixture-${scenario}-320-workspace.png`);
      const mobilePages = { workspace: mobileWorkspace };

      if (scenario === 'no-approvals' || scenario === 'no-funds') {
        await navigate('approvals');
        mobilePages.approvals = await audit('mobile-approvals');
        await screenshot(`fixture-${scenario}-320-approvals.png`);
      } else if (scenario !== 'gate-unavailable') {
        await navigate('receipts');
        mobilePages.receipts = await audit('mobile-receipts');
        const hasDetail = await evaluate(`Boolean(document.querySelector('[data-action="view-receipt"]'))`);
        if (hasDetail) {
          await evaluate(`document.querySelector('[data-action="view-receipt"]').click()`);
          await sleep(400);
          mobilePages.receiptDetail = await audit('mobile-receipt-detail');
          await screenshot(`fixture-${scenario}-320-receipt-detail.png`);
        }
      }

      const meta = fixtureServer.meta();
      scenarioReport.meta = meta;
      scenarioReport.viewports = [
        { name: 'desktop-1440', pages: desktopPages },
        { name: 'mobile-320', pages: mobilePages },
      ];

      for (const viewport of scenarioReport.viewports) {
        for (const [page, result] of Object.entries(viewport.pages)) {
          auditIssues(checks, `${scenario}/${viewport.name}/${page}`, result);
        }
      }

      const workspace = desktopWorkspace;
      if (scenario === 'no-approvals') {
        assert(checks, workspace.emptyTitle === 'No approvals in this set', `no-approvals: unexpected empty state ${workspace.emptyTitle}`);
        assert(checks, desktopPages.approvals?.emptyTitle === 'No approvals yet', 'no-approvals: approvals page did not show empty state');
        assert(checks, workspace.statusPill === null, 'no-approvals: unexpected status pill');
      }

      if (scenario === 'no-funds') {
        assert(checks, String(workspace.banner).includes('funding is insufficient'), `no-funds: banner mismatch ${workspace.banner}`);
        assert(checks, String(workspace.healthLine).includes('insufficient'), 'no-funds: health line did not report insufficient');
        const run = workspace.actions.find((action) => action.action === 'run');
        assert(checks, Boolean(run && run.disabled), 'no-funds: run action was not disabled');
      }

      if (scenario === 'gate-unavailable') {
        assert(checks, String(workspace.banner).includes('Signer unavailable'), `gate-unavailable: banner mismatch ${workspace.banner}`);
        assert(checks, meta.gateProbe === 'disconnected', `gate-unavailable: gate probe was ${meta.gateProbe}`);
        const run = workspace.actions.find((action) => action.action === 'run');
        assert(checks, Boolean(run && run.disabled), 'gate-unavailable: run action was not disabled');
      }

      if (scenario === 'signed') {
        assert(checks, String(workspace.resultTitle).includes('matches the approval'), `signed: result title ${workspace.resultTitle}`);
        assert(checks, workspace.actions.some((action) => action.action === 'broadcast' && !action.disabled), 'signed: broadcast action was not enabled');
        assert(checks, workspace.actions.some((action) => action.page === 'receipts'), 'signed: receipt action missing');
        assert(checks, desktopPages.receipts?.receiptTags.includes('SIGNED'), 'signed: receipt tag SIGNED missing');
        assert(checks, String(desktopPages.receiptDetail?.receiptDetail).includes('not-broadcast'), 'signed: receipt detail network mismatch');
      }

      if (scenario === 'pending') {
        assert(checks, String(workspace.resultTitle).includes('Broadcast on Zcash testnet'), `pending: result title ${workspace.resultTitle}`);
        assert(checks, workspace.actions.some((action) => action.action === 'status'), 'pending: status action missing');
        assert(checks, workspace.actions.some((action) => action.page === 'receipts'), 'pending: receipt action missing');
        assert(checks, desktopPages.receipts?.receiptTags.includes('PENDING'), 'pending: receipt tag PENDING missing');
        assert(checks, String(desktopPages.receiptDetail?.receiptDetail).includes('pending'), 'pending: receipt detail network mismatch');
      }

      if (scenario === 'broadcast_unknown') {
        assert(checks, String(workspace.resultTitle).includes('Broadcast outcome unknown'), `broadcast_unknown: result title ${workspace.resultTitle}`);
        assert(checks, workspace.actions.some((action) => action.action === 'status'), 'broadcast_unknown: status action missing');
        assert(checks, workspace.actions.some((action) => action.action === 'broadcast'), 'broadcast_unknown: retry action missing');
        assert(checks, workspace.actions.some((action) => action.page === 'receipts'), 'broadcast_unknown: receipt action missing');
        assert(checks, desktopPages.receipts?.receiptTags.includes('UNKNOWN'), 'broadcast_unknown: receipt tag UNKNOWN missing');
        assert(checks, String(desktopPages.receiptDetail?.receiptDetail).includes('unknown'), 'broadcast_unknown: receipt detail network mismatch');
      }

      scenarioReport.workspace = workspace;
      scenarioReport.actions = workspace.actions;
      report.scenarios.push(scenarioReport);
    } finally {
      await fixtureServer.close();
    }
  }

  if (browserErrors.length) checks.push(`browser errors: ${browserErrors.join(' | ')}`);
} finally {
  try {
    await send('Browser.close');
  } catch {
    // Chrome may already be closing.
  }
  ws.close();
  await sleep(300);
  if (chrome.exitCode === null) chrome.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

report.result = checks.length ? 'FAIL' : 'PASS';
await fs.writeFile(path.join(outDir, 'm3-fixture-ui.json'), JSON.stringify(report, null, 2));
const lines = [
  'Airlock M3 fixture-only UI checks',
  '',
  'Synthetic fixtures. Not proof of signing, broadcast, mining, or recovery.',
  'No real approval, demo set, payment, or live service was used.',
  '',
  `scenarios: ${report.scenarios.map((value) => value.scenario).join(', ')}`,
  `result: ${report.result}`,
  `browser_errors: ${browserErrors.length}`,
  ...checks.map((failure) => `FAIL: ${failure}`),
  '',
];
await fs.writeFile(path.join(outDir, 'fixture-checks.txt'), lines.join('\n'));
console.log(lines.join('\n'));
if (checks.length) process.exitCode = 1;
