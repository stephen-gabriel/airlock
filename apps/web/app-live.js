(function () {
  'use strict';

  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    book: '<path d="M3 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H3zM21 4h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6z"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    cross: '<path d="m6 6 12 12M6 18 18 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 13h5M16 16h1"/>',
  };

  const icon = (name, cls = '') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.shield}</svg>`;

  const mark =
    '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M9 38V10h12v28M27 38V10h12v28" stroke="#e3edbb" stroke-width="2"/><path d="M15 24h18m-5-5 5 5-5 5" stroke="#e3edbb" stroke-width="2"/></svg>';

  const illustration = () =>
    '<svg class="airlock-illustration" viewBox="0 0 260 140" fill="none" aria-hidden="true"><defs><pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="#729080" opacity=".5"/></pattern></defs><rect width="260" height="140" fill="url(#dots)"/><path d="M13 72h230" stroke="#779a87" stroke-dasharray="3 5"/><path d="m75 42 45-18 45 18v62l-45 18-45-18z" fill="#244e42" stroke="#95b79a"/><path d="m120 24 45 18-45 19-45-19 45-18Z" fill="#3b6450" stroke="#95b79a"/><path d="M120 61v61" stroke="#95b79a"/><path d="M92 91V61l17 7v30M132 98V68l17-7v30" stroke="#e3edbb" stroke-width="2"/><rect x="21" y="61" width="24" height="23" rx="4" fill="#173e39" stroke="#adc6aa"/><path d="M28 68h10M28 75h7" stroke="#dce9bc"/><circle cx="211" cy="72" r="15" fill="#e3edbb"/><path d="m205 72 4 4 8-9" stroke="#173e39" stroke-width="2"/><path d="M168 72h22m-5-4 5 4-5 4M48 72h20" stroke="#c6dba9"/></svg>';

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));

  const SCENARIOS = [
    { id: 'matching', name: 'Matches approval' },
    { id: 'changed-recipient', name: 'Changed recipient' },
    { id: 'hidden-memo', name: 'Hidden memo' },
    { id: 'excess-fee', name: 'Excess fee' },
  ];
  const SCENARIO_NAMES = {
    matching: 'Matches approval',
    'changed-recipient': 'Changed recipient',
    'hidden-memo': 'Hidden memo',
    'excess-fee': 'Excess fee',
    'forged-approval': 'Forged approval',
  };
  const FIELD_LABELS = {
    network: 'Network',
    recipient: 'Recipient',
    amount: 'Amount',
    fee: 'Fee cap',
    memo: 'Memo',
    change: 'Change',
    authorization: 'Authorization',
    expiry: 'Expiry',
  };
  const JOB_STATES = {
    queued: 'Queued',
    preparing: 'Building proposal',
    proving: 'Proving proposal',
    inspecting: 'Gate checking',
    signing: 'Signing',
    signed: 'Signed',
    broadcasting: 'Broadcasting',
    broadcast_unknown: 'Broadcast unknown',
    pending: 'Pending confirmation',
    confirmed: 'Confirmed',
    rejected: 'Rejected by gate',
    blocked: 'Blocked',
    failed: 'Failed',
    expired: 'Expired',
  };
  const ACTIVE_STATES = new Set(['queued', 'preparing', 'proving', 'inspecting', 'signing', 'broadcasting']);

  const state = {
    page: 'workspace',
    scenario: 'matching',
    session: null,
    health: null,
    jobs: [],
    receipts: [],
    selectedJobId: null,
    selectedReceiptId: null,
    loading: true,
    actionBusy: false,
    polling: false,
    error: null,
    statusCheckedAt: null,
    pollTimer: null,
    pollInterval: 0,
  };

  const announcer = () => document.getElementById('announcer');
  function announce(message) {
    const node = announcer();
    if (node) node.textContent = message;
  }

  function taz(zats) {
    try {
      const value = BigInt(String(zats));
      if (value < 0n) return String(zats);
      const whole = value / 100000000n;
      const fraction = (value % 100000000n).toString().padStart(8, '0');
      return `${whole}.${fraction}`;
    } catch {
      return String(zats == null ? '—' : zats);
    }
  }

  function zatsDisplay(zats) {
    return `${taz(zats)} TAZ`;
  }

  function short(value, head = 14, tail = 8) {
    const text = String(value == null ? '' : value);
    return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function approvalStatusLabel(status) {
    return ({ pending: 'Available', reserved: 'Reserved', completed: 'Used', abandoned: 'Withdrawn' }[status] || status || 'Unknown');
  }

  function isBusyState(value) {
    return ACTIVE_STATES.has(value);
  }

  function toSafeError(error) {
    if (error && error.safe && typeof error.safe.code === 'string') return error.safe;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return {
        code: error.code,
        message: error.message,
        stage: error.stage || 'client',
        retryable: Boolean(error.retryable),
      };
    }
    return {
      code: 'E_NETWORK',
      message: 'The browser could not reach the live Airlock API.',
      stage: 'client',
      retryable: true,
    };
  }

  function setError(error) {
    const safe = toSafeError(error);
    state.error = safe;
    if (safe.code === 'E_NO_SESSION') {
      state.session = null;
      state.jobs = [];
      state.receipts = [];
      state.selectedJobId = null;
    }
    announce(safe.message);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers,
      });
    } catch {
      throw {
        code: 'E_NETWORK',
        message: 'The browser could not reach the live Airlock API.',
        stage: 'client',
        retryable: true,
      };
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const safe = payload && payload.error
        ? payload.error
        : {
            code: `E_HTTP_${response.status}`,
            message: `The request failed with HTTP ${response.status}.`,
            stage: 'client',
            retryable: response.status >= 500,
          };
      const error = new Error(safe.message);
      error.safe = safe;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadHealth() {
    try {
      state.health = await api('/api/health');
    } catch (error) {
      const safe = toSafeError(error);
      state.health = {
        mode: 'live-testnet',
        status: 'offline',
        signer: 'unavailable',
        chainContext: 'unknown',
        funding: 'unknown',
        demoSetsRemaining: 0,
        sessionSlotsRemaining: 0,
        acceptingDemoSessions: false,
        reason: safe.message,
      };
    }
  }

  function approvalForScenario(scenario) {
    return (state.session && state.session.approvals || []).find((approval) => approval.scenario === scenario) || null;
  }

  function chooseScenario() {
    const order = ['matching', 'changed-recipient', 'hidden-memo'];
    if (approvalForScenario(state.scenario)) return;
    state.scenario = order.find((scenario) => approvalForScenario(scenario)) || 'matching';
  }

  function latestJobForApproval(approvalId) {
    if (!approvalId) return null;
    return state.jobs
      .filter((job) => job.approvalId === approvalId)
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  }

  function currentJob() {
    return state.jobs.find((job) => job.id === state.selectedJobId) || null;
  }

  function upsertJob(job) {
    if (!job) return;
    const index = state.jobs.findIndex((value) => value.id === job.id);
    if (index >= 0) state.jobs[index] = job;
    else state.jobs.unshift(job);
    state.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function loadJobs() {
    const payload = await api('/api/jobs');
    state.jobs = Array.isArray(payload && payload.jobs) ? payload.jobs : [];
    state.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (!selected) {
      const approval = approvalForScenario(state.scenario);
      state.selectedJobId = latestJobForApproval(approval && approval.id)?.id || null;
    }
  }

  async function loadReceipts() {
    const payload = await api('/api/receipts');
    state.receipts = Array.isArray(payload && payload.receipts) ? payload.receipts : [];
    if (state.selectedReceiptId && !state.receipts.some((receipt) => receipt.id === state.selectedReceiptId)) {
      state.selectedReceiptId = null;
    }
  }

  async function ensureSession() {
    try {
      state.session = await api('/api/session');
    } catch (error) {
      if (toSafeError(error).code !== 'E_NO_SESSION') throw error;
      state.session = await api('/api/demo/sessions', { method: 'POST' });
    }
  }

  async function loadSessionData() {
    await ensureSession();
    chooseScenario();
    await Promise.all([loadJobs(), loadReceipts()]);
    const approval = approvalForScenario(state.scenario);
    const job = latestJobForApproval(approval && approval.id);
    if (!state.selectedJobId || !state.jobs.some((value) => value.id === state.selectedJobId)) {
      state.selectedJobId = job ? job.id : null;
    }
  }

  function idemStorageKey(approvalId, scenario) {
    return `airlock:idem:${state.session ? state.session.sessionId : 'none'}:${approvalId}:${scenario}`;
  }

  function newId() {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  function getIdemKey(approvalId, scenario) {
    const key = idemStorageKey(approvalId, scenario);
    let value = null;
    try {
      value = sessionStorage.getItem(key);
      if (!value) {
        value = newId();
        sessionStorage.setItem(key, value);
      }
    } catch {
      value = newId();
    }
    return value;
  }

  function canStart(approval) {
    return Boolean(
      approval &&
        approval.status === 'pending' &&
        Date.parse(approval.expiresAt) > Date.now() &&
        state.health &&
        state.health.signer === 'available' &&
        state.health.funding !== 'insufficient',
    );
  }

  function anyBusyJob() {
    return state.jobs.some((job) => isBusyState(job.state));
  }

  async function startJob() {
    if (state.actionBusy) return;
    const approval = approvalForScenario(state.scenario);
    if (!approval) {
      setError({ code: 'E_NOT_FOUND', message: 'No approval is allocated for this scenario.', stage: 'client', retryable: false });
      render();
      return;
    }
    if (approval.status !== 'pending') {
      setError({ code: 'E_APPROVAL_CONSUMED', message: 'This approval has already been used.', stage: 'client', retryable: false });
      render();
      return;
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      setError({ code: 'E_APPROVAL_EXPIRED', message: 'This approval has expired.', stage: 'client', retryable: false });
      render();
      return;
    }
    if (anyBusyJob()) {
      setError({ code: 'E_AUTH_IN_USE', message: 'Another live check is already running. Wait for it to finish.', stage: 'client', retryable: true });
      render();
      return;
    }
    if (!state.health || state.health.signer !== 'available') {
      setError({ code: 'E_SIGNER_UNAVAILABLE', message: 'The signing service is unavailable. No simulated fallback exists.', stage: 'client', retryable: true });
      render();
      return;
    }
    if (state.health.funding === 'insufficient') {
      setError({ code: 'E_FUNDS_UNAVAILABLE', message: 'The demo wallet does not currently hold enough spendable testnet funds.', stage: 'client', retryable: true });
      render();
      return;
    }
    state.actionBusy = true;
    state.error = null;
    render();
    try {
      const payload = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Idempotency-Key': getIdemKey(approval.id, state.scenario) },
        body: JSON.stringify({ approvalId: approval.id, scenario: state.scenario }),
      });
      if (!payload || !payload.job) throw new Error('The API did not return a job.');
      upsertJob(payload.job);
      state.selectedJobId = payload.job.id;
      announce('Live gate job queued.');
    } catch (error) {
      setError(error);
    } finally {
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  async function retryJob() {
    const job = currentJob();
    if (!job || state.actionBusy) {
      await startJob();
      return;
    }
    state.actionBusy = true;
    state.error = null;
    render();
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}/resume`, { method: 'POST' });
      if (payload && payload.job) upsertJob(payload.job);
      announce('Resuming the same job with its retained artifacts.');
    } catch (error) {
      setError(error);
      await loadJobs().catch(() => undefined);
    } finally {
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  async function broadcastJob() {
    const job = currentJob();
    if (!job || (job.state !== 'signed' && job.state !== 'broadcast_unknown') || state.actionBusy) return;
    if (!state.health || state.health.signer !== 'available') {
      setError({ code: 'E_SIGNER_UNAVAILABLE', message: 'The signing service is unavailable; the signed artifact is retained.', stage: 'client', retryable: true });
      render();
      return;
    }
    state.actionBusy = true;
    state.error = null;
    render();
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}/broadcast`, { method: 'POST' });
      if (payload && payload.job) upsertJob(payload.job);
      announce('Broadcast requested on Zcash testnet.');
      await loadReceipts().catch(() => undefined);
    } catch (error) {
      setError(error);
      await loadJobs().catch(() => undefined);
    } finally {
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  async function checkStatus() {
    const job = currentJob();
    if (!job || state.actionBusy) return;
    state.actionBusy = true;
    state.error = null;
    render();
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}/status`, { method: 'POST' });
      if (payload && payload.job) upsertJob(payload.job);
      state.statusCheckedAt = new Date().toISOString();
      await loadReceipts().catch(() => undefined);
      announce('Network status checked.');
    } catch (error) {
      setError(error);
    } finally {
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  async function runMatching() {
    const approval = approvalForScenario('matching');
    if (!approval) {
      setError({ code: 'E_NOT_FOUND', message: 'No matching approval was provisioned for this demo set.', stage: 'client', retryable: false });
      render();
      return;
    }
    state.scenario = 'matching';
    state.error = null;
    const job = latestJobForApproval(approval.id);
    state.selectedJobId = job ? job.id : null;
    render();
    if (!job) await startJob();
    else syncPolling();
  }

  async function refreshHealth() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    await loadHealth();
    state.actionBusy = false;
    render();
  }

  async function refreshReceipts() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      await loadReceipts();
    } catch (error) {
      setError(error);
    } finally {
      state.actionBusy = false;
      render();
    }
  }

  async function refreshAll() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    state.error = null;
    render();
    try {
      await loadHealth();
      if (state.session) await loadSessionData();
    } catch (error) {
      setError(error);
    } finally {
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  async function connect() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    state.loading = true;
    state.error = null;
    render();
    try {
      state.session = await api('/api/demo/sessions', { method: 'POST' });
      chooseScenario();
      await Promise.all([loadJobs(), loadReceipts()]);
      const approval = approvalForScenario(state.scenario);
      const job = latestJobForApproval(approval && approval.id);
      state.selectedJobId = job ? job.id : null;
      announce('Live demo session connected.');
    } catch (error) {
      setError(error);
    } finally {
      state.loading = false;
      state.actionBusy = false;
      render();
      syncPolling();
    }
  }

  function syncPolling() {
    const job = currentJob();
    let interval = 0;
    if (job && isBusyState(job.state)) interval = 1500;
    else if (job && (job.state === 'pending' || job.state === 'broadcast_unknown')) interval = 8000;
    if (state.pollTimer && state.pollInterval !== interval) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (!interval) {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      state.pollInterval = 0;
      return;
    }
    if (!state.pollTimer) {
      state.pollInterval = interval;
      state.pollTimer = setInterval(() => {
        void pollSelected();
      }, interval);
    }
  }

  async function pollSelected() {
    if (state.actionBusy || state.polling) return;
    const job = currentJob();
    if (!job) return;
    state.polling = true;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      const next = payload && payload.job;
      if (!next) return;
      const changed = JSON.stringify(next) !== JSON.stringify(job);
      upsertJob(next);
      if (changed) {
        if (next.state === 'confirmed' || next.state === 'pending' || next.state === 'broadcast_unknown') {
          await loadReceipts().catch(() => undefined);
        }
        if (['signed', 'rejected', 'blocked', 'failed', 'confirmed'].includes(next.state)) {
          await loadHealth().catch(() => undefined);
        }
        render();
      }
      syncPolling();
    } catch (error) {
      if (toSafeError(error).code === 'E_NO_SESSION') {
        setError(error);
        render();
        syncPolling();
      }
    } finally {
      state.polling = false;
    }
  }

  function navigate(page) {
    if (!['workspace', 'approvals', 'receipts', 'guide'].includes(page)) return;
    state.page = page;
    if (page === 'receipts') state.selectedReceiptId = null;
    render();
    const main = document.getElementById('main');
    if (main) main.focus();
    if (page === 'receipts') void refreshReceipts();
  }

  function selectScenario(scenario) {
    if (!SCENARIOS.some((value) => value.id === scenario)) return;
    if (scenario === 'excess-fee' || !approvalForScenario(scenario)) return;
    state.scenario = scenario;
    state.error = null;
    state.statusCheckedAt = null;
    const approval = approvalForScenario(scenario);
    const job = latestJobForApproval(approval && approval.id);
    state.selectedJobId = job ? job.id : null;
    render();
    syncPolling();
    announce(`Selected ${SCENARIO_NAMES[scenario] || scenario}.`);
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportReceipts() {
    downloadJson({
      mode: 'live-testnet',
      exportedAt: new Date().toISOString(),
      sessionId: state.session ? state.session.sessionId : null,
      demoSetId: state.session ? state.session.demoSetId : null,
      notice: 'Live Zcash testnet receipts. These records describe Airlock decisions and observed testnet status; they are not evidence of mainnet settlement.',
      receipts: state.receipts,
    }, `airlock-live-receipts-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  }

  function exportReceipt(receipt) {
    if (!receipt) return;
    downloadJson({
      mode: 'live-testnet',
      exportedAt: new Date().toISOString(),
      sessionId: state.session ? state.session.sessionId : null,
      demoSetId: state.session ? state.session.demoSetId : null,
      notice: 'Live Zcash testnet receipt. This record describes an Airlock decision and observed testnet status; it is not evidence of mainnet settlement.',
      receipt,
    }, `airlock-receipt-${receipt.id}.json`);
  }

  function selectedReceipt() {
    return state.receipts.find((receipt) => receipt.id === state.selectedReceiptId) || null;
  }

  function empty(title, body, button, action, page = false) {
    const attribute = page ? `data-page="${action}"` : `data-action="${action}"`;
    return `<div class="empty">${icon('shield')}<h2>${esc(title)}</h2><p>${esc(body)}</p>${
      button ? `<button class="btn" ${attribute}>${esc(button)} ${icon('arrow')}</button>` : ''
    }</div>`;
  }

  function loadingResult(title) {
    return `<div class="result waiting" role="status">${icon('refresh', 'spin')}<div><h3>${esc(title)}</h3><p>Reading the live testnet workspace. No keys are loaded in the browser.</p><div class="progress"><span class="done"></span><span class="done"></span><span></span></div></div></div>`;
  }

  function healthLine() {
    if (!state.health) return 'Connecting to the signer.';
    const funding = state.health.funding || 'unknown';
    const sets = state.health.demoSetsRemaining;
    return `Gate ${state.health.signer} · funds ${funding} · ${sets} ${sets === 1 ? 'set' : 'sets'} left · chain ${state.health.chainContext} · ${state.health.status}`;
  }

  function banner() {
    if (state.error) {
      return `<div class="demo-banner error">${icon('info')}<span><b>${esc(state.error.code)}</b> ${esc(state.error.message)}</span><div class="banner-actions"><button class="text-btn" data-action="refresh-all">Retry</button><button class="text-btn" data-action="dismiss-error">Dismiss</button></div></div>`;
    }
    if (!state.health) {
      return `<div class="demo-banner">${icon('refresh', 'spin')}<span>Connecting to the isolated signer and the live gate…</span></div>`;
    }
    if (state.health.status === 'offline' || state.health.signer === 'unavailable') {
      return `<div class="demo-banner error">${icon('info')}<span><b>Signer unavailable.</b> ${esc(state.health.reason || 'The signing service is offline.')} The app will not simulate a signature.</span><div class="banner-actions"><button class="text-btn" data-action="refresh-health">Retry</button><button class="text-btn" data-page="guide">Guide</button></div></div>`;
    }
    if (state.health.funding === 'insufficient') {
      return `<div class="demo-banner error">${icon('wallet')}<span><b>Demo wallet funding is insufficient.</b> No proposal will be signed until spendable testnet funds cover the approved amount and fee cap.</span><div class="banner-actions"><button class="text-btn" data-action="refresh-health">Refresh</button><button class="text-btn" data-page="guide">Guide</button></div></div>`;
    }
    if (state.health.chainContext === 'stale') {
      return `<div class="demo-banner warn">${icon('clock')}<span><b>Chain context is stale.</b> The worker refreshes before a build; the gate still refuses a signature without a trustworthy testnet tip.</span><div class="banner-actions"><button class="text-btn" data-action="refresh-health">Refresh</button><button class="text-btn" data-page="guide">Guide</button></div></div>`;
    }
    if (state.health.status === 'degraded') {
      return `<div class="demo-banner warn">${icon('info')}<span><b>Gate limited.</b> ${esc(state.health.reason || 'Some signing checks are unavailable.')}</span><div class="banner-actions"><button class="text-btn" data-action="refresh-health">Refresh</button><button class="text-btn" data-page="guide">Guide</button></div></div>`;
    }
    if (!state.session && !state.health.acceptingDemoSessions) {
      return `<div class="demo-banner warn">${icon('info')}<span><b>No demo allocations available.</b> The signer is online, but every operator-provisioned set has been assigned.</span><div class="banner-actions"><button class="text-btn" data-action="refresh-health">Refresh</button><button class="text-btn" data-page="guide">Guide</button></div></div>`;
    }
    return `<div class="demo-banner">${icon('info')}<span><b>Live Zcash testnet.</b> Real gate decisions. Signing happens in the isolated worker; broadcasting is a separate testnet action. No mainnet funds.</span><div class="banner-actions"><button class="text-btn" data-page="guide">How it works</button></div></div>`;
  }

  function scenarioChips() {
    return `<div class="scenarios" aria-label="Proposal scenario">${SCENARIOS.map((scenario) => {
      const approval = approvalForScenario(scenario.id);
      const unavailable = scenario.id === 'excess-fee' || !approval;
      let title = scenario.id === 'excess-fee'
        ? 'This build does not produce an excess-fee proposal.'
        : approval
          ? `Approval ${approval.id} · ${approvalStatusLabel(approval.status)}`
          : 'No approval is allocated for this scenario.';
      if (approval && approval.status === 'completed') title += ' · retained result only';
      return `<button class="scenario ${state.scenario === scenario.id ? 'selected' : ''}" data-scenario="${scenario.id}" aria-pressed="${state.scenario === scenario.id}" ${unavailable ? 'disabled aria-disabled="true"' : ''} title="${esc(title)}">${scenario.name}${scenario.id === 'excess-fee' ? '<span class="chip-note">n/a</span>' : ''}</button>`;
    }).join('')}</div>`;
  }

  function previewChecks(approval) {
    return [
      { field: 'network', status: 'unknown', approvedDisplay: 'testnet', proposedDisplay: null },
      { field: 'recipient', status: 'unknown', approvedDisplay: approval.recipientUa, proposedDisplay: null },
      { field: 'amount', status: 'unknown', approvedDisplay: zatsDisplay(approval.amountZat), proposedDisplay: null },
      { field: 'fee', status: 'unknown', approvedDisplay: `at most ${zatsDisplay(approval.maxFeeZat)}`, proposedDisplay: null },
      { field: 'memo', status: 'unknown', approvedDisplay: approval.memo.display, proposedDisplay: null },
      { field: 'change', status: 'unknown', approvedDisplay: 'wallet change only', proposedDisplay: null },
      { field: 'authorization', status: 'unknown', approvedDisplay: 'single-use approval', proposedDisplay: null },
      { field: 'expiry', status: 'unknown', approvedDisplay: `expires ${formatDate(approval.expiresAt)}`, proposedDisplay: null },
    ];
  }

  function checksTable(checks) {
    return `<table class="comparison"><caption class="sr-only">Approved terms compared with the gate's findings</caption><thead><tr><th scope="col">Field</th><th scope="col">You approved</th><th scope="col">Gate found</th><th scope="col"><span class="sr-only">Result</span></th></tr></thead><tbody>${checks.map((check) => {
      const status = check.status || 'unknown';
      const className = status === 'mismatch' ? 'bad' : status === 'unknown' ? 'unknown' : '';
      const iconName = status === 'match' ? 'check' : status === 'mismatch' ? 'cross' : 'info';
      const proposed = check.proposedDisplay ? esc(check.proposedDisplay) : '—';
      const mono = check.field === 'recipient' ? 'mono' : '';
      return `<tr><td>${esc(FIELD_LABELS[check.field] || check.field)}</td><td class="${mono}">${esc(check.approvedDisplay)}</td><td class="${className} ${mono}" title="${esc(check.reasonCode || '')}">${proposed}</td><td class="${className}">${icon(iconName)}<span class="sr-only">${esc(status)}</span></td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function mismatchField(job) {
    const check = (job && job.checks || []).find((value) => value.status === 'mismatch');
    return check ? FIELD_LABELS[check.field] || check.field : 'Gate decision';
  }

  function jobMeta(job) {
    const rows = [];
    if (job.txid) rows.push(`<div><span>TxID</span><code class="mono-wrap">${esc(job.txid)}</code></div>`);
    if (job.artifactSha256) rows.push(`<div><span>Artifact SHA-256</span><code class="mono-wrap">${esc(job.artifactSha256)}</code></div>`);
    if (job.proposal && job.proposal.feeZat) rows.push(`<div><span>Gate fee</span><strong>${esc(job.proposal.feeZat)} zats</strong></div>`);
    if (job.minedHeight != null) rows.push(`<div><span>Mined height</span><strong>${esc(job.minedHeight)}</strong></div>`);
    if (job.signedAt) rows.push(`<div><span>Signed</span><strong>${esc(formatDate(job.signedAt))}</strong></div>`);
    if (job.updatedAt) rows.push(`<div><span>Updated</span><strong>${esc(formatDate(job.updatedAt))}</strong></div>`);
    return rows.length ? `<div class="job-meta">${rows.join('')}</div>` : '';
  }

  function progressMarkup(job) {
    const order = ['preparing', 'proving', 'inspecting', 'signing', 'broadcasting'];
    const index = order.indexOf(job.state);
    const first = index >= 1 ? 'done' : '';
    const second = index >= 2 ? 'done' : '';
    const third = index >= 4 ? 'done' : '';
    return `<div class="progress"><span class="${first}"></span><span class="${second}"></span><span class="${third}"></span></div>`;
  }

  function jobResult(job) {
    if (!job) {
      return `<div class="result waiting" role="status">${icon('info')}<div><h3>Ready to inspect</h3><p>The gate has not seen a proposal for this approval yet.</p><code>NO_PROPOSAL</code></div></div>`;
    }
    if (isBusyState(job.state)) {
      const titles = {
        queued: 'Queued for the trusted worker',
        preparing: 'Building the proposal',
        proving: 'Proving the PCZT',
        inspecting: 'Gate is inspecting the proposal',
        signing: 'Releasing one signature',
        broadcasting: 'Broadcasting to testnet',
      };
      const descriptions = {
        queued: 'The live pipeline will start as soon as the worker is free.',
        preparing: 'The constrained worker is creating a PCZT from the fixed approval terms.',
        proving: 'Real zero-knowledge proving runs locally. This can take a little while.',
        inspecting: 'The isolated gate compares the actual proposal bytes with the operator approval.',
        signing: 'The gate is signing a matching proposal. The browser never sees the key.',
        broadcasting: 'The retained signed artifact is being sent to the testnet network.',
      };
      return `<div class="result waiting" role="status">${icon('refresh', 'spin')}<div><h3>${esc(titles[job.state] || JOB_STATES[job.state] || job.state)}</h3><p>${esc(descriptions[job.state] || 'The live pipeline is working.')}</p>${progressMarkup(job)}</div></div>`;
    }
    if (job.state === 'signed') {
      return `<div class="result" role="status">${icon('check')}<div><h3>Proposal matches the approval</h3><p>The gate released one signature. The signed artifact is retained; broadcasting is a separate, explicit testnet action.</p><code>SIGN_OK · ${esc(short(job.txid, 16, 16))}</code>${jobMeta(job)}</div></div>`;
    }
    if (job.state === 'pending') {
      return `<div class="result waiting" role="status">${icon('clock')}<div><h3>Broadcast on Zcash testnet</h3><p>The signed transaction was handed to the broadcaster. Waiting for mempool visibility and confirmation can take minutes.</p><code class="mono-wrap">TXID ${esc(job.txid || '—')}</code>${jobMeta(job)}<p>Last checked ${esc(formatTime(state.statusCheckedAt || job.updatedAt))}.</p></div></div>`;
    }
    if (job.state === 'confirmed') {
      return `<div class="result" role="status">${icon('check')}<div><h3>Confirmed on Zcash testnet</h3><p>The recipient wallet sees this transaction. The receipt records the observed height.</p><code class="mono-wrap">TXID ${esc(job.txid || '—')}</code>${jobMeta(job)}</div></div>`;
    }
    if (job.state === 'broadcast_unknown') {
      return `<div class="result error" role="status">${icon('info')}<div><h3>Broadcast outcome unknown</h3><p>${esc(job.error && job.error.message || 'The broadcaster did not confirm whether the transaction reached the network.')} The original signed artifact is retained. Check status; do not create a second payment.</p><code>${esc(job.error && job.error.code || 'E_BROADCAST_UNKNOWN')}</code>${jobMeta(job)}</div></div>`;
    }
    if (job.state === 'rejected' || job.state === 'expired') {
      return `<div class="result error" role="status">${icon('shield')}<div><h3>${job.state === 'expired' ? 'Approval expired' : `Blocked · ${esc(mismatchField(job))}`}</h3><p>${esc(job.error && job.error.message || 'The gate refused the proposal.')}</p><code>${esc(job.error && job.error.code || 'E_POLICY')} · ${esc(job.error && job.error.stage || 'gate')}</code></div></div>`;
    }
    if (job.state === 'blocked') {
      return `<div class="result waiting" role="status">${icon('info')}<div><h3>No signature released</h3><p>${esc(job.error && job.error.message || 'The signer could not complete the check.')}</p><code>${esc(job.error && job.error.code || 'E_BLOCKED')} · ${esc(job.error && job.error.stage || 'gate')}</code></div></div>`;
    }
    return `<div class="result error" role="status">${icon('cross')}<div><h3>Check failed</h3><p>${esc(job.error && job.error.message || 'The proposal could not be completed.')}</p><code>${esc(job.error && job.error.code || 'E_INTERNAL')} · ${esc(job.error && job.error.stage || 'server')}</code></div></div>`;
  }

  function actionArea(job, approval) {
    const healthReady = Boolean(state.health && state.health.signer === 'available');
    const actionBusy = state.actionBusy;
    if (!job) {
      let explanation = 'A live check builds and proves a real PCZT, then asks the gate to sign only if every approved term matches. It does not broadcast.';
      if (!healthReady) explanation = 'The signing service is offline. No proposal can be signed, and there is no simulation fallback.';
      else if (approval.status !== 'pending') explanation = 'This approval is already used. A single approval can bind only one payment.';
      else if (Date.parse(approval.expiresAt) <= Date.now()) explanation = 'This approval has expired; the operator must provision a new set.';
      return `<div class="action-area"><div class="action-copy"><p>${esc(explanation)}</p></div><button class="btn" data-action="run" ${!canStart(approval) || actionBusy ? 'disabled' : ''}>${actionBusy ? icon('refresh', 'spin') : icon('shield')}Run live gate check</button></div>`;
    }
    if (isBusyState(job.state)) {
      return `<div class="action-area"><div class="action-copy"><p>The browser is waiting for the isolated pipeline. It never builds or signs locally.</p></div><button class="btn" disabled>${icon('refresh', 'spin')}${esc(JOB_STATES[job.state] || 'Working')}…</button></div>`;
    }
    if (job.state === 'signed') {
      return `<div class="action-area"><div class="action-copy"><p>Broadcasting is irreversible and uses testnet TAZ. The signed artifact stays retained${healthReady ? '' : '; the worker is currently unavailable'}.</p></div><div class="live-action-row"><button class="btn" data-action="broadcast" ${actionBusy || !healthReady ? 'disabled' : ''}>${actionBusy ? icon('refresh', 'spin') : icon('arrow')}Broadcast to testnet</button><button class="btn secondary" data-page="receipts">View receipt</button></div></div>`;
    }
    if (job.state === 'pending') {
      return `<div class="action-area"><div class="action-copy"><p>Testnet confirmation can take minutes. The API also reconciles pending payments in the background.</p></div><div class="live-action-row"><button class="btn" data-action="status" ${actionBusy ? 'disabled' : ''}>${actionBusy ? icon('refresh', 'spin') : icon('clock')}Check status</button><button class="btn secondary" data-page="receipts">View receipt</button></div></div>`;
    }
    if (job.state === 'broadcast_unknown') {
      return `<div class="action-area"><div class="action-copy"><p>The API checks the original txid first, then may resubmit the identical retained artifact. It never builds a replacement payment for this approval.</p></div><div class="live-action-row"><button class="btn" data-action="status" ${actionBusy ? 'disabled' : ''}>${actionBusy ? icon('refresh', 'spin') : icon('clock')}Check status</button><button class="btn secondary" data-action="broadcast" ${actionBusy || !healthReady ? 'disabled' : ''}>${icon('refresh')}Retry original broadcast</button><button class="btn secondary" data-page="receipts">View receipt</button></div></div>`;
    }
    if (job.state === 'rejected' || job.state === 'expired') {
      const matchingApproval = state.scenario !== 'matching' ? approvalForScenario('matching') : null;
      const matchingJob = matchingApproval ? latestJobForApproval(matchingApproval.id) : null;
      const matchingLabel = matchingJob
        ? 'View matching payment'
        : matchingApproval && canStart(matchingApproval)
          ? 'Run matching approval'
          : null;
      return `<div class="action-area"><div class="action-copy"><p>No signature was released. ${approval.status === 'pending' ? 'The single-use approval is still available unless the gate reports it consumed.' : 'The approval is marked used.'}</p></div><div class="live-action-row">${matchingLabel ? `<button class="btn secondary" data-action="run-matching">${matchingLabel}</button>` : ''}<button class="btn secondary" data-page="receipts">View receipt</button></div></div>`;
    }
    if (job.state === 'blocked' || job.state === 'failed') {
      const canRetry = approval.status === 'pending' && healthReady && (job.error ? job.error.retryable : true);
      return `<div class="action-area"><div class="action-copy"><p>No signature was released. Resume this same job to reuse retained proofs and signed artifacts without creating a second payment.</p></div><div class="live-action-row"><button class="btn" data-action="retry" ${!canRetry || actionBusy ? 'disabled' : ''}>${actionBusy ? icon('refresh', 'spin') : icon('refresh')}Resume job</button><button class="btn secondary" data-page="receipts">View receipt</button></div></div>`;
    }
    if (job.state === 'confirmed') {
      return `<div class="action-area"><div class="action-copy"><p>This approval is complete. The receipt records the observed testnet confirmation.</p></div><div class="live-action-row"><button class="btn secondary" data-page="receipts">View receipt</button><button class="btn secondary" data-page="approvals">Review approvals</button></div></div>`;
    }
    return `<div class="action-area"><div class="action-copy"><p>The job is in a terminal state.</p></div><button class="btn secondary" data-page="receipts">View receipt</button></div>`;
  }

  function workspaceAside(approval) {
    return `<aside class="right-stack" aria-label="Signing boundary"><section class="boundary-card"><div class="eyebrow">The Airlock principle</div><h2>Let the payment through.<br>Keep control.</h2><p>A proposal gets a signature only when it fits the permission the operator gave.</p>${illustration()}<div class="boundary-caption"><span>PROPOSAL</span><span>POLICY GATE</span><span>SIGNATURE</span></div></section><section class="card rail-panel"><h3>Live boundary</h3><ul class="check-list"><li>${icon('lock')}<div><b>Signing keys</b>Held by the isolated worker, never the browser.</div></li><li>${icon('shield')}<div><b>Gate decision</b>${state.health ? esc(`Signer ${state.health.signer}; chain context ${state.health.chainContext}.`) : 'Checking the isolated signer.'}</div></li><li>${icon('wallet')}<div><b>Testnet only</b>${approval ? esc(`${zatsDisplay(approval.amountZat)} demo payment; no mainnet funds.`) : 'No mainnet funds.'}</div></li></ul><button class="text-btn mini-link" data-page="guide">Explore the boundary ${icon('arrow')}</button></section><div class="receipt-hint">${icon('receipt')}<span>Receipts record gate decisions and observed testnet status. They do not by themselves prove settlement.</span></div></aside>`;
  }

  function workspace() {
    if (state.loading && !state.session) {
      return `<section class="card page-card">${loadingResult('Connecting to the live workspace')}</section>`;
    }
    if (!state.session) {
      return `<section class="card page-card">${empty('No live session', 'Connect this browser to an operator-provisioned demo set. The browser never loads a wallet, keys, or approval authority.', 'Connect to demo', 'connect')}</section>`;
    }
    const approvals = state.session.approvals || [];
    if (!approvals.length) {
      return `<section class="card page-card">${empty('No approvals in this set', 'The operator has not provisioned a usable permission for this session. A payment cannot be signed without one.', 'Refresh session', 'refresh-all')}</section>`;
    }
    const approval = approvalForScenario(state.scenario);
    if (!approval) {
      return `<section class="card page-card"><div class="notice"><p>This scenario has no approval. Choose an available scenario from the workspace.</p></div><button class="btn" data-page="approvals">Review approvals</button></section>`;
    }
    const job = currentJob();
    const checks = job && job.checks && job.checks.length ? job.checks : previewChecks(approval);
    const pill = job ? (JOB_STATES[job.state] || job.state) : approvalStatusLabel(approval.status);
    return `<div class="grid"><section class="card" aria-label="Payment review"><div class="card-header"><div><h2><span class="step-number">01</span>Payment review</h2><small>One approval. One real testnet payment.</small></div><span class="status-pill">${esc(pill)}</span></div><div class="payment-hero"><div class="payment-identity"><div class="payment-icon">${icon('wallet')}</div><div><h3>${esc(approval.recipientLabel || 'Approved recipient')}</h3><p>${esc(SCENARIO_NAMES[approval.scenario] || approval.scenario)} · ${esc(approval.id)}</p></div></div><div class="payment-amount"><strong>${esc(taz(approval.amountZat))} <span>TAZ</span></strong><small>Testnet units · no cash value</small></div></div><dl class="approval-strip"><div><dt>Approved by</dt><dd>Operator (out of band)</dd></div><div><dt>Permission</dt><dd>Single payment</dd></div><div><dt>Validity</dt><dd>Expires ${esc(formatDate(approval.expiresAt))}</dd></div></dl><div class="section-bar"><span class="eyebrow">Inspect a proposal</span><span class="muted" style="font-size:10px">The gate checks actual PCZT bytes</span></div>${scenarioChips()}<div class="table-note">${job ? 'Findings are returned by the gate. A field marked unknown was not separately disclosed after the gate stopped at the first failure.' : 'No proposal has been inspected. A live check builds and proves a real testnet PCZT; it does not broadcast.'}</div>${checksTable(checks)}<div class="table-note">The signed artifact is retained. Broadcasting is a separate action and can be retried only by status reconciliation, never by silently rebuilding a payment.</div>${jobResult(job)}${actionArea(job, approval)}</section>${workspaceAside(approval)}</div>`;
  }

  function approvalsPage() {
    if (!state.session) {
      return `<section class="card page-card">${empty('No live session', 'Connect the browser to see the operator-provisioned approvals for this demo set.', 'Connect to demo', 'connect')}</section>`;
    }
    const approvals = state.session.approvals || [];
    const remainingSets = state.health ? state.health.demoSetsRemaining : null;
    const remainingSlots = state.health ? state.health.sessionSlotsRemaining : null;
    const capacity = state.health
      ? `Funds ${esc(state.health.funding || 'unknown')} · ${esc(remainingSets)} ${remainingSets === 1 ? 'set' : 'sets'} unassigned · ${esc(remainingSlots)} ${remainingSlots === 1 ? 'session slot' : 'session slots'} left`
      : 'Capacity unavailable';
    const sessionLine = `<div class="session-line"><span>Demo set <b>${esc(state.session.demoSetId)}</b></span><span>Session ends ${esc(formatDate(state.session.expiresAt))}</span><span>${capacity}</span></div>`;
    if (!approvals.length) {
      return `<section class="card page-card"><div class="page-toolbar"><div><h2>Approval registry</h2><p>Operator permissions, kept separate from proposed transactions.</p></div><button class="btn secondary" data-page="workspace">Review</button></div>${sessionLine}${empty('No approvals yet', 'The operator must provision a single-use approval before the browser can propose a payment.', 'Review workspace', 'workspace', true)}</section>`;
    }
    const cards = approvals.map((approval) => `<article class="policy approval-card"><div class="eyebrow"><span>${esc(SCENARIO_NAMES[approval.scenario] || approval.scenario)}</span><span class="status-pill">${esc(approvalStatusLabel(approval.status))}</span></div><h3>${esc(zatsDisplay(approval.amountZat))}</h3><p><b>Approval</b><br><code>${esc(approval.id)}</code></p><p><b>Recipient</b><br><span class="mono-wrap">${esc(approval.recipientUa)}</span></p><p><b>Fee cap</b> at most ${esc(zatsDisplay(approval.maxFeeZat))}</p><p><b>Memo</b> <span class="mono-wrap">${esc(approval.memo.display)}</span></p><p><b>Expires</b> ${esc(formatDate(approval.expiresAt))}</p>${approval.boundTxid ? `<p><b>Bound TxID</b><br><code class="mono-wrap">${esc(approval.boundTxid)}</code></p>` : ''}</article>`).join('');
    return `<section class="card page-card"><div class="page-toolbar"><div><h2>Approval registry</h2><p>Operator permissions for this live testnet session.</p></div><button class="btn secondary" data-page="workspace">Review a proposal</button></div>${sessionLine}<div class="policy-grid">${cards}<article class="policy approval-card"><div class="eyebrow"><span>Operator boundary</span><span class="status-pill">Read only</span></div><h3>Provisioned before the demo</h3><p>The browser has no create, widen, or reset endpoint. Every approval is single-use and binds to the first signed transaction.</p><p>Amounts, recipients, memos, fees, and expiries are fixed by the operator.</p></article></div><div class="notice"><p><b>No public approval authority.</b> A public visitor cannot create or change an approval. The API only selects from the operator-provisioned set; the gate enforces the terms.</p></div><button class="text-btn" data-page="workspace">Inspect a proposal ${icon('arrow')}</button></section>`;
  }

  function receiptTag(receipt) {
    if (receipt.decision === 'rejected') return 'REJECTED';
    if (receipt.networkStatus === 'confirmed') return 'CONFIRMED';
    if (receipt.networkStatus === 'pending') return 'PENDING';
    if (receipt.networkStatus === 'unknown') return 'UNKNOWN';
    if (receipt.networkStatus === 'expired') return 'EXPIRED';
    return 'SIGNED';
  }

  function receiptTagClass(receipt) {
    if (receipt.decision === 'rejected' || receipt.networkStatus === 'unknown' || receipt.networkStatus === 'expired') return 'tag offline';
    if (receipt.networkStatus === 'confirmed') return 'tag gate';
    return 'tag';
  }

  function receiptTitle(receipt) {
    if (receipt.decision === 'rejected') return 'Proposal rejected by gate';
    if (receipt.networkStatus === 'confirmed') return 'Payment confirmed on testnet';
    if (receipt.networkStatus === 'pending') return 'Payment broadcast on testnet';
    if (receipt.networkStatus === 'unknown') return 'Broadcast outcome unknown';
    return 'Payment signed; not broadcast';
  }

  function receiptDetail(receipt) {
    const transaction = receipt.txid
      ? `<code class="mono-wrap" title="${esc(receipt.txid)}">${esc(receipt.txid)}</code>`
      : '<span>No transaction was broadcast.</span>';
    return `<section class="card page-card"><div class="page-toolbar"><div><span class="${receiptTagClass(receipt)}">${esc(receiptTag(receipt))}</span><h2>${esc(receiptTitle(receipt))}</h2><p>${esc(receipt.reasonCode)} · ${esc(formatDate(receipt.createdAt))}</p></div><div class="live-action-row"><button class="btn secondary" data-action="back-receipts">${icon('arrow')}All receipts</button><button class="btn secondary" data-action="export-receipt" data-receipt-id="${esc(receipt.id)}">${icon('download')}Export receipt</button></div></div><div class="receipt-details"><span><b>Receipt</b> ${esc(receipt.id)}</span><span><b>Decision</b> ${esc(receipt.decision)}</span><span><b>Network</b> ${esc(receipt.networkStatus)}</span><span><b>Job</b> ${esc(receipt.jobId)}</span><span><b>Approval</b> ${esc(receipt.approvalId)}</span><span><b>Mode</b> ${esc(receipt.mode)}</span>${receipt.minedHeight != null ? `<span><b>Mined height</b> ${esc(receipt.minedHeight)}</span>` : ''}${receipt.artifactSha256 ? `<span><b>Artifact SHA-256</b> <code class="mono-wrap">${esc(receipt.artifactSha256)}</code></span>` : ''}<span><b>Transaction</b> ${transaction}</span></div><p class="copy-note">This receipt records an Airlock decision and the status observed from the recipient wallet. It is not cryptographic proof of settlement.</p></section>`;
  }

  function receiptsPage() {
    if (!state.session) {
      return `<section class="card page-card">${empty('No live session', 'Connect the browser to see gate decisions from this session.', 'Connect to demo', 'connect')}</section>`;
    }
    const detail = selectedReceipt();
    if (detail) return receiptDetail(detail);
    if (state.loading && !state.receipts.length) {
      return `<section class="card page-card">${loadingResult('Loading live receipts')}</section>`;
    }
    const list = state.receipts.map((receipt) => `<article class="receipt-item ${receipt.decision === 'rejected' ? 'rejected' : ''}">${icon(receipt.decision === 'rejected' ? 'shield' : 'check')}<div class="receipt-body"><h3>${esc(receiptTitle(receipt))}</h3><p>${esc(receipt.reasonCode)} · ${esc(formatDate(receipt.createdAt))} · ${esc(receipt.id)}</p><div class="receipt-details">${receipt.txid ? `<code class="mono-wrap" title="${esc(receipt.txid)}">TXID ${esc(short(receipt.txid, 16, 16))}</code>` : '<span>No transaction was broadcast.</span>'}${receipt.minedHeight != null ? `<span>Mined height ${esc(receipt.minedHeight)}</span>` : ''}${receipt.artifactSha256 ? `<span>Artifact SHA-256 ${esc(short(receipt.artifactSha256, 16, 16))}</span>` : ''}<span>Job ${esc(receipt.jobId)} · ${esc(receipt.mode)}</span><button class="text-btn" data-action="view-receipt" data-receipt-id="${esc(receipt.id)}">Details ${icon('arrow')}</button></div></div><span class="${receiptTagClass(receipt)}">${esc(receiptTag(receipt))}</span></article>`).join('');
    return `<section class="card page-card"><div class="page-toolbar"><div><h2>Live receipts</h2><p>Gate decisions and observed testnet status from this session.</p></div><div class="live-action-row"><button class="btn secondary" data-action="refresh-receipts" ${state.actionBusy ? 'disabled' : ''}>${icon('refresh')}Refresh</button><button class="btn secondary" data-action="export" ${!state.receipts.length ? 'disabled' : ''}>${icon('download')}Export JSON</button></div></div>${!state.receipts.length ? empty('A clean slate', 'Run a live gate check to record an accepted or rejected proposal here.', 'Review a proposal', 'workspace', true) : `<div class="receipt-list">${list}</div>`}<p class="copy-note">Receipts describe Airlock decisions and the status observed from the recipient wallet. A receipt alone is not cryptographic proof of settlement.</p></section>`;
  }

  function guidePage() {
    return `<section class="card page-card"><h2>Give permission to a payment.</h2><p>Airlock checks a proposed shielded transaction against an operator's approved terms before the isolated signer releases a signature.</p><div class="flow"><div><span class="step-number">01</span><h3>Approve the intent</h3><p>The operator sets the exact recipient, amount, memo bytes, a fee ceiling, and an expiry. The browser cannot change them.</p></div><div><span class="step-number">02</span><h3>Build and inspect</h3><p>The constrained worker creates and proves a real PCZT. The isolated gate compares the actual bytes with the approval.</p></div><div><span class="step-number">03</span><h3>Release one signature</h3><p>A matching proposal is bound to the single-use approval. Broadcasting is a separate, explicit testnet action.</p></div></div><div class="notice"><p><b>The boundary matters.</b> The browser never receives the gate MAC key, wallet seed, approval authority, or subprocess control. The API cannot create approvals; it can only ask the worker to build fixed proposals and ask the gate to check them.</p></div><div class="policy-grid"><article class="policy"><div class="eyebrow">What is real</div><h3>Zcash testnet</h3><p>Real PCZT construction and proving, real policy inspection, a real signature, and a real testnet broadcast with recipient-wallet confirmation.</p></article><article class="policy"><div class="eyebrow">What is absent</div><h3>No mainnet</h3><p>No mainnet funds, no custody product, no public approval endpoint, and no fallback that pretends a failed gate succeeded.</p></article><article class="policy"><div class="eyebrow">Single use</div><h3>One approval · one payment</h3><p>Once signed, the approval is bound to its transaction. A retry returns the retained artifact or a consumed-approval decision, not a second payment.</p></article><article class="policy"><div class="eyebrow">Hostile cases</div><h3>Changed bytes stop</h3><p>Changed recipient, hidden memo suffix, excess fee, forged approval, missing chain context, or an unavailable signer produce a refusal or a blocker.</p></article></div><code class="guide-code">E_POLICY_RECIPIENT · E_POLICY_MEMO · E_POLICY_FEE · E_AUTH_CONSUMED · E_TIP_UNAVAILABLE</code><button class="text-btn" data-page="workspace">Try a live proposal ${icon('arrow')}</button></section>`;
  }

  function pageContent() {
    if (state.page === 'approvals') return approvalsPage();
    if (state.page === 'receipts') return receiptsPage();
    if (state.page === 'guide') return guidePage();
    return workspace();
  }

  function shell() {
    const pages = { workspace: 'Payment review', approvals: 'Approvals', receipts: 'Receipts', guide: 'How it works' };
    const counts = {
      workspace: state.jobs.length,
      approvals: state.session && state.session.approvals ? state.session.approvals.length : 0,
      receipts: state.receipts.length,
      guide: 0,
    };
    const gateLabel = !state.health
      ? 'CONNECTING'
      : state.health.status === 'ready'
        ? 'GATE READY'
        : state.health.status === 'degraded'
          ? 'GATE LIMITED'
          : 'GATE OFFLINE';
    const gateClass = state.health && state.health.status === 'ready' ? 'tag gate' : 'tag offline';
    const headings = {
      workspace: 'Private by design.<br>Precise by permission.',
      approvals: 'Set the boundaries.',
      receipts: 'Every decision, explained.',
      guide: 'An approval that holds.',
    };
    const descriptions = {
      workspace: 'Review the intent. Inspect the live proposal. Let only the right testnet payment through.',
      approvals: 'Operator permissions for this demo session. The browser cannot create or widen them.',
      receipts: 'Gate decisions and observed testnet status from this session.',
      guide: 'Give an application a payment task without giving it the signing keys.',
    };
    const introRight = {
      workspace: '01 / Approval → proposal',
      approvals: '02 / Operator → registry',
      receipts: '03 / Gate → receipt',
      guide: '04 / Boundary → proof',
    };
    const nav = [
      ['workspace', 'grid', 'Review', 'jobs'],
      ['approvals', 'shield', 'Approvals', 'approvals'],
      ['receipts', 'receipt', 'Receipts', 'receipts'],
      ['guide', 'book', 'Guide', ''],
    ].map(([id, iconName, label, itemName]) => {
      const count = counts[id] || 0;
      const countNoun = itemName && count === 1 ? itemName.slice(0, -1) : itemName;
      const countLabel = itemName ? `, ${count} ${countNoun}` : '';
      return `<button data-page="${id}" class="${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''} aria-label="${label}${countLabel}">${icon(iconName)}${label}${id !== 'guide' ? `<span class="count" aria-hidden="true">${String(count).padStart(2, '0')}</span>` : ''}</button>`;
    }).join('');
    return `<div class="shell"><aside class="sidebar" aria-label="Application navigation"><button class="brand" data-page="workspace" aria-label="Airlock home">${mark}<div><span class="brand-name">airlock</span><small>Intent. Enforced.</small></div></button><div class="nav-label">Control room</div><nav class="nav">${nav}</nav><div class="sidebar-bottom"><div class="rail-card"><div class="eyebrow">A boundary before signing</div><p>Your app proposes.<br>Your approval sets the limits.<br>Airlock checks the difference.</p></div><div class="rail-footer"><span><i class="dot"></i>Zcash testnet</span><span>v0.1 / live</span></div></div></aside><div class="main-wrap"><header class="topbar"><div class="breadcrumbs">Workspace <span>/</span> ${pages[state.page]}</div><div class="top-actions"><span class="tag testnet"><i class="dot"></i>TESTNET</span><span class="${gateClass}"><i class="dot"></i>${gateLabel}</span><button class="text-btn" data-page="guide">How it works ↗</button><span class="avatar" aria-label="Demo workspace">AL</span></div></header><main id="main" class="workspace" tabindex="-1"><div class="intro"><div><div class="eyebrow">Shielded payments. Explicit permission.</div><h1>${headings[state.page]}</h1><p>${descriptions[state.page]}</p></div><div class="intro-right"><strong>${introRight[state.page]}</strong><br>One boundary.<br>A meaningful difference.</div></div>${banner()}${pageContent()}<footer class="footer"><span>Airlock / Permission before signature.${state.session ? ` · Session ends ${esc(formatDate(state.session.expiresAt))}` : ''}</span><div class="state-controls"><span class="live-note ${state.health && state.health.status === 'ready' ? '' : 'offline'}"><i class="dot"></i>${esc(healthLine())}</span><button class="text-btn" data-action="refresh-health" ${state.actionBusy ? 'disabled' : ''}>Health</button><button class="text-btn" data-action="refresh-all" ${state.actionBusy ? 'disabled' : ''}>Refresh</button></div></footer></main></div></div>`;
  }

  function render(focusSelector) {
    const active = document.activeElement;
    const action = active && active.getAttribute ? active.getAttribute('data-action') : null;
    const scenario = active && active.getAttribute ? active.getAttribute('data-scenario') : null;
    const page = active && active.getAttribute ? active.getAttribute('data-page') : null;
    document.getElementById('app').innerHTML = shell();
    let target = null;
    if (focusSelector) target = document.querySelector(focusSelector);
    if (!target && scenario) target = document.querySelector(`[data-scenario="${scenario}"]`);
    if (!target && action) target = document.querySelector(`[data-action="${action}"]`);
    if (!target && page) target = document.querySelector(`[data-page="${page}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button');
    if (!button || button.disabled) return;
    const page = button.getAttribute('data-page');
    if (page) {
      event.preventDefault();
      navigate(page);
      return;
    }
    const scenario = button.getAttribute('data-scenario');
    if (scenario) {
      event.preventDefault();
      selectScenario(scenario);
      return;
    }
    const action = button.getAttribute('data-action');
    if (!action) return;
    event.preventDefault();
    if (action === 'dismiss-error') {
      state.error = null;
      render();
      return;
    }
    if (action === 'export') {
      exportReceipts();
      return;
    }
    if (action === 'view-receipt') {
      const receiptId = button.getAttribute('data-receipt-id');
      if (receiptId) {
        state.selectedReceiptId = receiptId;
        render();
        const main = document.getElementById('main');
        if (main) main.focus();
      }
      return;
    }
    if (action === 'back-receipts') {
      state.selectedReceiptId = null;
      render();
      const main = document.getElementById('main');
      if (main) main.focus();
      return;
    }
    if (action === 'export-receipt') {
      const receiptId = button.getAttribute('data-receipt-id');
      exportReceipt(state.receipts.find((receipt) => receipt.id === receiptId) || null);
      return;
    }
    if (action === 'refresh-health') {
      void refreshHealth();
      return;
    }
    if (action === 'refresh-receipts') {
      void refreshReceipts();
      return;
    }
    if (action === 'refresh-all' || action === 'refresh-session') {
      void refreshAll();
      return;
    }
    if (action === 'connect') {
      void connect();
      return;
    }
    if (action === 'run') {
      void startJob();
      return;
    }
    if (action === 'retry') {
      void retryJob();
      return;
    }
    if (action === 'broadcast') {
      void broadcastJob();
      return;
    }
    if (action === 'status') {
      void checkStatus();
      return;
    }
    if (action === 'run-matching') {
      void runMatching();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void pollSelected();
  });

  async function init() {
    state.loading = true;
    render();
    await loadHealth();
    try {
      await loadSessionData();
    } catch (error) {
      setError(error);
    }
    state.loading = false;
    render();
    syncPolling();
  }

  void init();
})();
