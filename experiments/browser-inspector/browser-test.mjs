// Dependency-free Chrome CDP smoke/regression test. Own profile, loopback static files only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { staticServer } from './serve.mjs';
import { appAssets } from './static-assets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'chrome-'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const server = staticServer();
const requests = [];
server.on('request', request => requests.push({ method: request.method, path: request.url }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, ws, debug;
const errors = [];
const network = [];
const pending = new Map();
let nextId = 0;
let workerSessions = new Set();
const browserVersion = {};
const screenshots = [];
const uiChecks = [];
const usabilityAudits = [];
let intentionalWasmFailure = false;
const expectedErrors = [];

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`CDP timeout: ${method}`));
    }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitUI(predicate) {
  return evaluate(`new Promise((resolve,reject)=>{
    let observer;
    const check=()=>{if(${predicate}){clearTimeout(timer);observer?.disconnect();resolve(true);}};
    const timer=setTimeout(()=>{observer?.disconnect();reject(Error('UI state timeout'));},20000);
    observer=new MutationObserver(check);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
    check();
  })`);
}
async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  screenshots.push(`artifacts/${name}.png`);
}
async function inspectSelected() {
  await evaluate(`document.querySelector('#inspect').click()`);
  await waitUI(`document.querySelector('#result').textContent.startsWith('{')`);
}
async function auditReadability(label) {
  const audit = await evaluate(`(()=>{
    const selectors='.helper,.card-header p,.example-card p,.example-type,.boundary-card p,.boundary-caption,.boundary-list li,.scope-details p,.receipt-hint,.row-note,.coverage-row p,.memo-byte-count,.memo-caution,.memo-preview-label';
    const elements=[...document.querySelectorAll(selectors)].filter(element=>element.getClientRects().length);
    const rgb=text=>text.match(/[\\d.]+/g).slice(0,3).map(Number);
    const luminance=color=>rgb(color).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const contrast=element=>{
      let parent=element;
      while(parent && ['rgba(0, 0, 0, 0)','transparent'].includes(getComputedStyle(parent).backgroundColor)) parent=parent.parentElement;
      const background=parent?getComputedStyle(parent).backgroundColor:'rgb(243, 242, 236)';
      const a=luminance(getComputedStyle(element).color),b=luminance(background);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    };
    return {overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      tiny:elements.filter(element=>parseFloat(getComputedStyle(element).fontSize)<14).map(element=>element.className),
      lowContrast:elements.filter(element=>contrast(element)<4.5).map(element=>({className:element.className,contrast:contrast(element)}))};
  })()`);
  assert.deepEqual(audit, { overflow: 0, tiny: [], lowContrast: [] }, label);
  usabilityAudits.push({ label, ...audit });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeServer = () => new Promise(resolve => server.close(resolve));
try {
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let spawnError;
  chrome.once('error', error => { spawnError = error; });
  // Startup readiness only, not polling a background tool job.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError) throw spawnError;
    try {
      debug = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
      if (debug) break;
    } catch { /* own browser still starting */ }
    await pause(100);
  }
  if (!debug) throw new Error('Chrome debug endpoint unavailable');
  Object.assign(browserVersion, await fetch(`http://127.0.0.1:${debug}/json/version`).then(r => r.json()));
  const target = await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push('console.error');
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry;
      if (intentionalWasmFailure && entry.url?.endsWith('/inspector.wasm') && entry.text.includes('503')) expectedErrors.push(entry.text);
      else errors.push(entry.text);
    }
    if (message.method === 'Fetch.requestPaused') {
      const params = message.params;
      send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 503,
        responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: Buffer.from('Intentional checker-load regression').toString('base64') })
        .catch(error => errors.push(error.message));
    }
    if (message.method === 'Network.requestWillBeSent') network.push({
      url: message.params.request.url, method: message.params.request.method,
      target: message.sessionId ? 'worker' : 'page',
    });
    if (message.method === 'Target.attachedToTarget') {
      const session = message.params.sessionId;
      workerSessions.add(session);
      Promise.all([
        send('Network.enable', {}, session),
        send('Runtime.enable', {}, session),
      ]).then(() => send('Runtime.runIfWaitingForDebugger', {}, session))
        .catch(error => errors.push(`Worker instrumentation: ${error.message}`));
    }
  });
  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable'), send('Page.enable')]);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin });
  // Await module loading without arbitrary sleeps between actions.
  await evaluate(`new Promise((resolve,reject)=>{
    if(document.readyState==='complete') resolve();
    else { window.addEventListener('load',resolve,{once:true}); setTimeout(()=>reject(Error('page timeout')),10000); }
  })`);
  await waitUI(`document.querySelector('#status').textContent==='Local checker ready'`);
  await screenshot('desktop-empty');
  const policy = await readFile(path.join(here, 'web/fixtures/policy.json'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(here, 'web/fixtures/manifest.json'), 'utf8'));
  const results = [];
  for (const fixture of manifest) {
    const result = await evaluate(`(async()=>{
      const app=await import('./app.js');
      const bytes=await fetch('./fixtures/${fixture.name}.bin').then(r=>r.arrayBuffer());
      try { return await app.inspectBytes(bytes, ${JSON.stringify(policy)}); }
      catch(error) { return { rejected: error.message }; }
    })()`);
    if (fixture.name === 'oversized') {
      assert.match(result.rejected, /256 KiB/);
    } else {
      assert.deepEqual(result.report, fixture.nativeReport, `native/WASM: ${fixture.name}`);
      if (!result.report.parsed || result.report.scope === 'uncheckable') {
        assert.equal(await evaluate(`document.querySelector('#results').dataset.state`), 'error');
      } else if (result.report.scope === 'unsupported') {
        assert.equal(await evaluate(`document.querySelector('#results').dataset.state`), 'unsupported');
      }
      if (fixture.name === 'altered-ciphertext') {
        assert.equal(result.comparison.policyMismatch, false);
        assert.equal(await evaluate(`document.querySelector('#result-summary').textContent`), 'Disclosure checks found inconsistencies');
      }
    }
    results.push({ name: fixture.name, class: fixture.class, bytes: fixture.bytes, ...result });
  }
  const byName = Object.fromEntries(results.map(result => [result.name, result]));
  const status = (name, field) => byName[name].report.actions?.[0]?.[field]?.status;
  const base = byName['unsigned-valid-partial'];
  assert.equal(base.report.scope, 'supported');
  assert.equal(base.report.transactionValidity, 'NOT VERIFIED');
  assert.equal(base.comparison.status, 'matches_proposal');
  assert.equal(base.report.actions[0].hasSpendSignature, false);
  assert.equal(base.report.fee.disclosedNetZat, '10000');
  for (const field of ['noteCommitment', 'valueCommitment', 'nullifier', 'randomizedKey', 'memo']) assert.equal(status('unsigned-valid-partial', field), 'consistent');
  assert.equal(status('altered-amount', 'noteCommitment'), 'inconsistent');
  assert.equal(status('altered-amount', 'valueCommitment'), 'inconsistent');
  assert.equal(status('altered-recipient', 'noteCommitment'), 'inconsistent');
  assert.equal(status('altered-ciphertext', 'memo'), 'inconsistent');
  assert.equal(byName['altered-fee'].report.fee.status, 'inconsistent');
  assert.equal(status('missing-rseed', 'memo'), 'unavailable');
  assert.equal(status('missing-rseed', 'noteCommitment'), 'unavailable');
  assert.equal(status('missing-value', 'noteCommitment'), 'unavailable');
  assert.equal(byName['missing-value'].report.fee.status, 'unavailable');
  assert.equal(status('missing-fvk', 'nullifier'), 'unavailable');
  assert.equal(status('missing-fvk', 'randomizedKey'), 'unavailable');
  for (const name of ['missing-fvk', 'missing-cross-address-evidence']) {
    assert.equal(byName[name].comparison.outputStatus, 'matches_proposal');
    assert.equal(byName[name].coverage.status, 'incomplete');
  }
  assert.equal(byName['inconsistent-cross-address'].comparison.outputStatus, 'matches_proposal');
  assert.equal(byName['inconsistent-cross-address'].coverage.status, 'inconsistent');
  assert.equal(byName['omitted-commitments'].report.actions[0].memo.cmxSource, 'reconstructed');
  assert.match(byName['omitted-commitments'].report.actions[0].memo.evidence, /no independent supplied cmx/);
  for (const result of results) for (const field of result.comparison?.fields || []) {
    if (field.status === 'unavailable') assert.equal(field.matchesClaim, null);
  }
  assert.equal(status('missing-recipient', 'noteCommitment'), 'unavailable');
  assert.equal(status('missing-rcv', 'valueCommitment'), 'unavailable');
  assert.equal(status('altered-spend-rho', 'nullifier'), 'inconsistent');
  assert.equal(status('altered-alpha', 'randomizedKey'), 'inconsistent');
  assert.equal(status('compact-memo', 'memo'), 'reconstructed');
  assert.equal(byName['compact-memo'].comparison.status, 'unavailable');
  assert.equal(status('omitted-commitments', 'noteCommitment'), 'reconstructed');
  assert.equal(status('omitted-commitments', 'valueCommitment'), 'reconstructed');
  assert.equal(byName['omitted-commitments'].comparison.status, 'unavailable');
  assert.equal(byName['network-claim'].report.metadata.networkVerified, false);
  assert.equal(byName['network-claim'].comparison.status, 'mismatch');
  assert.equal(byName['expiry-claim'].comparison.status, 'mismatch');
  assert.equal(byName['bad-field-encoding'].report.scope, 'uncheckable');
  for (const name of ['unsupported-version', 'too-many-actions']) {
    assert.equal(byName[name].report.scope, 'unsupported');
    assert.equal(byName[name].comparison.status, 'unavailable');
  }
  for (const name of ['truncated', 'bad-magic']) assert.equal(byName[name].report.parsed, false);
  // Hostile label is shown literally, creates no elements and runs no script.
  const xss = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const bytes=await fetch('./fixtures/hostile-label.bin').then(r=>r.arrayBuffer());
    await app.inspectBytes(bytes,${JSON.stringify(policy)});
    return { literal:document.querySelector('#result').textContent.includes('<img src='),
      imgCount:document.querySelector('#result').querySelectorAll('img').length, executed:Boolean(globalThis.pwned) };
  })()`);
  assert.deepEqual(xss, { literal: true, imgCount: 0, executed: false });

  const policyTests = await evaluate(`(async()=>{
    const {parsePolicy,comparePolicy}=await import('./policy.js');
    const base=${JSON.stringify(base.report)};
    const original=JSON.parse(${JSON.stringify(policy)});
    const mutations=[
      p=>p.outputs[0].recipientRaw='00'.repeat(43),
      p=>p.outputs[0].amountZat='99999',
      p=>p.outputs[0].memoHex='00'.repeat(512),
      p=>p.maxFeeZat='9999'
    ];
    const statuses=mutations.map(mutate=>{const p=structuredClone(original);mutate(p);return comparePolicy(base,parsePolicy(JSON.stringify(p))).status;});
    const invalid=['x'.repeat(16385), '{}', '{"maxFeeZat":1}', JSON.stringify({...original,unexpected:true}),
      JSON.stringify({...original,maxFeeZat:'1e4'}), JSON.stringify({...original,outputs:[{...original.outputs[0],memoHex:'00'}]})];
    return {statuses,rejected:invalid.map(text=>{try{parsePolicy(text);return false;}catch{return true;}})};
  })()`);
  assert.deepEqual(policyTests.statuses, ['mismatch', 'mismatch', 'mismatch', 'mismatch']);
  assert.ok(policyTests.rejected.every(Boolean));
  // Render-only presentation is exercised through actual WASM with a hostile intended
  // memo and a browser-created local File name, never a simulated passing proposal.
  const hostilePresentation = await evaluate(`(async()=>{
    const bytes=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
    const name='<img src=x onerror="globalThis.pwned=1">.pczt';
    const memo='<img src=x onerror="globalThis.pwned=1">\\0\\r\\n\\t\\u202e';
    const intended=JSON.parse(${JSON.stringify(policy)});
    intended.outputs[0].memoHex=[...new TextEncoder().encode(memo)].map(byte=>byte.toString(16).padStart(2,'0')).join('').padEnd(1024,'0');
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],name));
    const picker=document.querySelector('#pczt');picker.files=transfer.files;picker.dispatchEvent(new Event('change'));
    const editor=document.querySelector('#policy');editor.value=JSON.stringify(intended);editor.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#inspect').click();
    return {name,hex:intended.outputs[0].memoHex};
  })()`);
  await waitUI(`document.querySelector('#result').textContent.startsWith('{')`);
  assert.deepEqual(await evaluate(`({
    filename:document.querySelector('#filename').textContent,
    elements:document.querySelectorAll('#filename img,.memo-value img').length,
    executed:Boolean(globalThis.pwned),
    exact:document.querySelector('.memo-value .long-value code').textContent,
    tokens:document.querySelector('.memo-preview').textContent.includes('[NUL][CR][LF]'),
    bidi:document.querySelector('.memo-preview').textContent.includes('[U+202E]')
  })`), { filename: hostilePresentation.name, elements: 0, executed: false, exact: hostilePresentation.hex, tokens: true, bidi: true });
  await auditReadability('desktop: hostile filename and memo');
  const invalidMemo = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const intended=JSON.parse(${JSON.stringify(policy)});intended.outputs[0].memoHex='ff'+'00'.repeat(511);
    await app.inspectBytes(await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer()),JSON.stringify(intended));
    return {invalid:document.querySelector('.memo-value').dataset.validUtf8,
      noPreview:!document.querySelector('.memo-value').querySelector('.memo-preview'),
      exact:document.querySelector('.memo-value .long-value code').textContent===intended.outputs[0].memoHex};
  })()`);
  assert.deepEqual(invalidMemo, { invalid: 'false', noPreview: true, exact: true });
  uiChecks.push('real WASM with hostile filename/memo, literal safe preview, invisible-byte tokens and exact hex; invalid UTF-8 has no lossy preview');
  // Actual file chooser path: the application reads a File, not an HTTP API upload.
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pczt' });
  await send('DOM.setFileInputFiles', { nodeId, files: [path.join(here, 'web/fixtures/unsigned-valid-partial.bin')] });
  await evaluate(`document.querySelector('#policy').value=${JSON.stringify(policy)}; document.querySelector('#policy').dispatchEvent(new Event('input',{bubbles:true}));`);
  await inspectSelected();
  const ui = await evaluate(`JSON.parse(document.querySelector('#result').textContent).comparison.status`);
  assert.equal(ui, 'matches_proposal');
  await evaluate(`document.querySelector('#clear').click()`);
  assert.ok(await evaluate(`document.querySelector('#result-summary').textContent==='Workspace cleared' && !document.querySelector('#result').textContent && !document.querySelector('#pczt').files.length && !document.querySelector('#policy').value`));

  // Visible examples load real static proposals and require an actual WASM inspection.
  for (const [name, expected, state] of [['matching', 'matches_proposal', 'match'], ['altered', 'mismatch', 'mismatch'], ['missing', 'matches_proposal', 'incomplete']]) {
    await evaluate(`document.querySelector('[data-example="${name}"]').click()`);
    await waitUI(`document.querySelector('[data-example="${name}"]').getAttribute('aria-pressed')==='true' && !document.querySelector('#inspect').disabled`);
    assert.equal(await evaluate(`document.querySelector('#result').textContent`), '');
    await inspectSelected();
    assert.equal(await evaluate(`JSON.parse(document.querySelector('#result').textContent).comparison.status`), expected);
    assert.equal(await evaluate(`document.querySelector('#results').dataset.state`), state);
    if (name === 'missing') {
      assert.ok(await evaluate(`document.querySelector('#coverage').textContent.includes('Spend nullifier') && document.querySelector('#coverage').textContent.includes('Randomized key') && document.querySelector('#coverage').querySelectorAll('[data-evidence="unavailable"]').length===2`));
      assert.ok(await evaluate(`document.querySelector('#coverage').textContent.includes('full viewing key (FVK) is missing') && document.querySelector('#coverage').textContent.includes('Cannot recompute the paired spend nullifier') && document.querySelector('#coverage').textContent.includes('Cannot recompute the randomized spend key')`));
    }
    if (name === 'altered') {
      assert.deepEqual(await evaluate(`(()=>{
        const row=document.querySelector('[data-field="output[0].amountZat"]');
        return {expected:row.children[1].textContent,actual:row.children[2].textContent,
          explanation:row.textContent.includes('disclosed value differs from your expected policy') && row.textContent.includes('Cryptographic disclosure checks failed')};
      })()`), { expected: '100000', actual: '100001', explanation: true });
    }
    if (name === 'matching') {
      assert.ok(await evaluate(`document.querySelector('.memo-preview').textContent.includes('SYNTHETIC inspector fixture') && document.querySelector('.memo-byte-count').textContent.includes('512 bytes total') && document.querySelector('.memo-invisible').textContent.includes('their intent is unknown') && document.querySelector('.memo-caution').textContent.includes('not equality evidence')`));
    }
    await auditReadability(`desktop: ${name} example`);
    await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
    await screenshot(`desktop-${name}-results`);
    uiChecks.push(`public ${name} example: real WASM, ${state}`);
  }
  // Editing a policy immediately removes technical and human-readable stale results.
  await evaluate(`const amount=document.querySelector('#output-0-amountZat');amount.value='99999';amount.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.ok(await evaluate(`!document.querySelector('#result').textContent && document.querySelector('#result-contents').hidden && document.querySelector('#results').dataset.state==='empty'`));
  uiChecks.push('input changes clear stale results');

  const supersession = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const first=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
    const second=await fetch('./fixtures/altered-amount.bin').then(r=>r.arrayBuffer());
    const settled=await Promise.allSettled([app.inspectBytes(first,${JSON.stringify(policy)}),app.inspectBytes(second,${JSON.stringify(policy)})]);
    return {old:settled[0].reason?.name,current:settled[1].value?.comparison.status,
      rendered:JSON.parse(document.querySelector('#result').textContent).comparison.status};
  })()`);
  assert.deepEqual(supersession, { old: 'Cancelled', current: 'mismatch', rendered: 'mismatch' });
  const editedDuringInspection = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const bytes=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
    const task=app.inspectBytes(bytes,${JSON.stringify(policy)});
    const field=document.querySelector('#max-fee');field.value='9999';field.dispatchEvent(new Event('input',{bubbles:true}));
    const settled=await Promise.allSettled([task]);
    return {cancelled:settled[0].reason?.name,cleared:!document.querySelector('#result').textContent,state:document.querySelector('#results').dataset.state};
  })()`);
  assert.deepEqual(editedDuringInspection, { cancelled: 'Cancelled', cleared: true, state: 'empty' });
  uiChecks.push('cancelled and superseded inspections cannot replace current results');
  const clearedDuringInspection = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const bytes=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
    const task=app.inspectBytes(bytes,${JSON.stringify(policy)});
    document.querySelector('#clear').click();
    const settled=await Promise.allSettled([task]);
    return {cancelled:settled[0].reason?.name,cleared:!document.querySelector('#result').textContent,
      title:document.querySelector('#result-summary').textContent};
  })()`);
  assert.deepEqual(clearedDuringInspection, { cancelled: 'Cancelled', cleared: true, title: 'Workspace cleared' });
  uiChecks.push('clear cancels in-flight inspection without stale replacement');

  const formChecks = await evaluate(`(async()=>{
    const app=await import('./app.js');
    await app.loadExample('matching');
    const text=document.querySelector('#output-0-memo');
    text.value='é';text.dispatchEvent(new Event('input',{bubbles:true}));
    const memoHex=JSON.parse(document.querySelector('#policy').value).outputs[0].memoHex;
    const mode=document.querySelector('[aria-label="Memo encoding for output 1"]');mode.value='hex';mode.dispatchEvent(new Event('change'));
    const exact=document.querySelector('#output-0-memo').value;
    const extra=exact+'00';document.querySelector('#output-0-memo').value=extra;document.querySelector('#output-0-memo').dispatchEvent(new Event('input',{bubbles:true}));
    const notTruncated=document.querySelector('#output-0-memo').value===extra;
    const rejected=!document.querySelector('#policy-error').hidden;
    const json=JSON.parse(${JSON.stringify(policy)});
    json.outputs=Array.from({length:8},(_,i)=>({...json.outputs[0],amountZat:String(i+1)}));
    const editor=document.querySelector('#policy');editor.value=JSON.stringify(json);editor.dispatchEvent(new Event('input',{bubbles:true}));
    const maxDisabled=document.querySelector('#add-output').disabled;
    document.querySelector('[aria-label="Move up output 2"]').click();
    const order=JSON.parse(editor.value).outputs.slice(0,2).map(output=>output.amountZat);
    document.querySelector('[aria-label="Remove output 8"]').click();
    return {utf8:memoHex.startsWith('c3a9'),exact:exact===memoHex,notTruncated,rejected,maxDisabled,order,
      count:document.querySelectorAll('.output-editor').length,canAdd:!document.querySelector('#add-output').disabled};
  })()`);
  assert.deepEqual(formChecks, { utf8: true, exact: true, notTruncated: true, rejected: true, maxDisabled: true, order: ['2', '1'], count: 7, canAdd: true });
  uiChecks.push('form/JSON synchronization, exact memo conversion and ordered 8-output controls');

  // Main-workflow screenshots and layout checks at desktop and 390 px.
  await evaluate(`(async()=>{await (await import('./app.js')).loadExample('matching');})()`);
  await inspectSelected();
  await evaluate(`window.scrollTo(0,0)`);
  await screenshot('desktop-workflow');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`window.scrollTo(0,0)`);
  await screenshot('mobile-workflow');
  await evaluate(`document.querySelector('#intended-policy').scrollIntoView({block:'start'})`);
  await screenshot('mobile-policy');
  await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
  await screenshot('mobile-results');
  const mobileAudit = await evaluate(`({
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    unlabeled:[...document.querySelectorAll('input,textarea,select')].filter(element=>!element.labels?.length&&!element.getAttribute('aria-label')).map(element=>element.id),
    brokenAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(link=>!document.querySelector(link.getAttribute('href'))).length,
    illustrationSquare:Math.abs(document.querySelector('.airlock-illustration').getBoundingClientRect().width-document.querySelector('.airlock-illustration').getBoundingClientRect().height)<1
  })`);
  assert.deepEqual(mobileAudit, { overflow: 0, unlabeled: [], brokenAnchors: 0, illustrationSquare: true });
  await evaluate(`document.querySelector('.skip').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle!=='none'`));
  uiChecks.push('390px no horizontal overflow, labeled fields, working anchors, square artwork, keyboard focus');

  // The deployment directory is exercised as static files, without test-fixture routes.
  const deployed = staticServer({ directory: path.join(here, 'dist'), fixtures: false });
  await new Promise(resolve => deployed.listen(0, '127.0.0.1', resolve));
  const deploymentOrigin = `http://127.0.0.1:${deployed.address().port}`;
  try {
    assert.equal((await fetch(`${deploymentOrigin}/fixtures/unsigned-valid-partial.bin`)).status, 404);
    await send('Page.navigate', { url: deploymentOrigin });
    await waitUI(`document.querySelector('#status')?.textContent==='Local checker ready'`);
    await evaluate(`document.querySelector('[data-example="matching"]').click()`);
    await waitUI(`document.querySelector('[data-example="matching"]').getAttribute('aria-pressed')==='true' && !document.querySelector('#inspect').disabled`);
    await inspectSelected();
    assert.equal(await evaluate(`JSON.parse(document.querySelector('#result').textContent).comparison.status`), 'matches_proposal');
    // Inspect the actual built static output, not just the development source.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await auditReadability('dist desktop: matching');
    await evaluate(`document.querySelector('.example-steps').scrollIntoView({block:'start'})`);
    await screenshot('dist-desktop-examples');
    await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
    await screenshot('dist-desktop-results');
    await evaluate(`document.querySelector('[data-field="output[0].memoHex"]').scrollIntoView({block:'start'})`);
    await screenshot('dist-desktop-memo');
    // A policy-only mismatch must not be described as a cryptographic failure.
    await evaluate(`const amount=document.querySelector('#output-0-amountZat');amount.value='99999';amount.dispatchEvent(new Event('input',{bubbles:true}));`);
    await inspectSelected();
    assert.deepEqual(await evaluate(`(()=>{
      const value=JSON.parse(document.querySelector('#result').textContent);
      return {title:document.querySelector('#result-summary').textContent,policy:value.comparison.policyMismatch,coverage:value.coverage.status};
    })()`), { title: 'The proposal differs from your policy', policy: true, coverage: 'consistent' });
    await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
    await screenshot('dist-desktop-policy-mismatch');
    await evaluate(`(async()=>{await (await import('./app.js')).loadExample('matching');})()`);
    await inspectSelected();
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector('.example-steps').scrollIntoView({block:'start'})`);
    await screenshot('dist-mobile-examples');
    await evaluate(`document.querySelector('#intended-policy').scrollIntoView({block:'start'})`);
    await screenshot('dist-mobile-policy');
    await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
    await screenshot('dist-mobile-results');
    await evaluate(`document.querySelector('[data-field="output[0].memoHex"]').scrollIntoView({block:'start'});document.querySelector('.memo-invisible').open=true;`);
    await screenshot('dist-mobile-memo');
    await evaluate(`document.querySelector('.long-value').open=true`);
    await auditReadability('dist 390px: expanded exact memo hex and invisible-byte details');
    assert.equal(await evaluate(`document.querySelector('.long-value code').textContent.length`), 1024);
    for (const name of ['altered', 'missing']) {
      await evaluate(`document.querySelector('[data-example="${name}"]').click()`);
      await waitUI(`document.querySelector('[data-example="${name}"]').getAttribute('aria-pressed')==='true' && !document.querySelector('#inspect').disabled`);
      assert.equal(await evaluate(`document.querySelector('#result').textContent`), '');
      await inspectSelected();
      await auditReadability(`dist 390px: ${name}`);
      await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
      await screenshot(`dist-mobile-${name}-results`);
      if (name === 'missing') {
        await evaluate(`document.querySelector('[data-evidence="unavailable"]').scrollIntoView({block:'start'})`);
        await screenshot('dist-mobile-missing-coverage');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
        await evaluate(`document.querySelector('#results').scrollIntoView({block:'start'})`);
        await screenshot('dist-desktop-missing-results');
        await evaluate(`document.querySelector('[data-evidence="unavailable"]').scrollIntoView({block:'start'})`);
        await screenshot('dist-desktop-missing-coverage');
      }
    }
    uiChecks.push('built dist desktop and 390px: described examples, readable expected/disclosed comparison, exact memo preview/hex, missing-check explanations, zero overflow and AA contrast for essential text');
    uiChecks.push('minimal deployment output: actual WASM and public example, no fixture route');
  } finally { await new Promise(resolve => deployed.close(resolve)); }

  // A real failed WASM request is displayed, then retried against the real asset.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  intentionalWasmFailure = true;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*inspector.wasm', requestStage: 'Request' }] });
  await send('Page.navigate', { url: origin });
  await waitUI(`document.querySelector('#status')?.textContent==='Checker unavailable'`);
  assert.ok(await evaluate(`!document.querySelector('#retry-wasm').hidden && document.querySelector('#inspect').disabled && !document.querySelector('#result').textContent`));
  await screenshot('desktop-wasm-failure');
  await send('Fetch.disable');
  await evaluate(`document.querySelector('#retry-wasm').click()`);
  await waitUI(`document.querySelector('#status').textContent==='Local checker ready'`);
  assert.equal(await evaluate(`document.querySelector('#result-summary').textContent`), 'Local checker ready');
  intentionalWasmFailure = false;
  uiChecks.push('WASM HTTP failure: useful no-result state, disabled inspect, working retry');

  // Forced worker deadline fails closed and does not create a successful report.
  const timeout = await evaluate(`(async()=>{
    const app=await import('./app.js');
    const bytes=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
    try{await app.inspectBytes(bytes,${JSON.stringify(policy)},{timeoutMs:0});return false;}
    catch(error){return error.message.includes('timed out');}
  })()`);
  assert.equal(timeout, true);
  const timings = [];
  for (let i = 0; i < 7; i++) {
    timings.push(await evaluate(`(async()=>{
      const app=await import('./app.js');
      const bytes=await fetch('./fixtures/unsigned-valid-partial.bin').then(r=>r.arrayBuffer());
      const r=await app.inspectBytes(bytes,${JSON.stringify(policy)});
      return {inspectMs:r.inspectMs,instantiateAndInspectMs:r.instantiateAndInspectMs,memoryBytes:r.memoryBytes};
    })()`));
  }
  const external = network.filter(request => !request.url.startsWith(`${origin}/`) && !request.url.startsWith(`${deploymentOrigin}/`));
  assert.equal(external.length, 0, JSON.stringify(external));
  assert.ok(requests.every(request => request.method === 'GET' && !request.path.includes('?')));
  const unexpected = errors.filter(error => !error.includes('favicon.ico'));
  assert.deepEqual(unexpected, []);
  const files = appAssets;
  const sizes = {};
  for (const name of files) {
    const bytes = await readFile(path.join(here, 'web', name));
    sizes[name] = { raw: bytes.length, gzip: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const evidence = {
    verdict: 'LIMITED-GO', browser: browserVersion.Browser, node: process.version,
    fixtureCount: results.length, sizes, coldLoad: base.load, timings,
    browserErrors: unexpected,
    network: { externalRequests: external, requests: network.map(request => ({ ...request, url: request.url.replace(origin, '<static-origin>').replace(deploymentOrigin, '<deployment-origin>') })), serverMethods: [...new Set(requests.map(request => request.method))] },
    xss, policyTests, fileInputUI: ui, workerTimeoutRejected: timeout,
    workerTargetsObserved: workerSessions.size,
    uiChecks, formChecks, mobileAudit, usabilityAudits, supersession, editedDuringInspection, screenshots, expectedErrors,
    results: results.map(({ name, class: fixtureClass, bytes, rejected, report, comparison, inspectMs, memoryBytes }) => ({
      name, class: fixtureClass, bytes, rejected, parsed: report?.parsed, scope: report?.scope,
      comparison: comparison?.status, inspectMs, memoryBytes,
      checks: report?.actions?.map(action => Object.fromEntries(['noteCommitment', 'valueCommitment', 'nullifier', 'randomizedKey', 'memo'].map(key => [key, action[key].status]))),
      fee: report?.fee?.status,
    })),
  };
  await writeFile(path.join(here, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: evidence.verdict, fixtureCount: evidence.fixtureCount, browser: evidence.browser, wasm: sizes['inspector.wasm'], coldLoad: evidence.coldLoad, timings, externalRequests: external.length, browserErrors: unexpected }, null, 2));
} finally {
  ws?.close();
  chrome?.kill();
  for (const call of pending.values()) call.reject(new Error('Browser test ended'));
  pending.clear();
  await closeServer();
  // Profile stays in ignored artifacts for troubleshooting; never touch a user's browser.
}
