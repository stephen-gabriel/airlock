import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appAssets, publicExamples } from './static-assets.mjs';
import { parsePolicy, comparePolicy, disclosureCoverage, explainComparison, explainDisclosure } from './web/policy.js';
import { textToMemoHex, memoHexToText, describeMemo } from './web/memo.js';
import { createWasmLoader, createInspector, Cancelled, MAX_INPUT } from './web/engine.js';
import { staticServer } from './serve.mjs';

const manifest = JSON.parse(await readFile(new URL('./web/fixtures/manifest.json', import.meta.url)));
const reports = Object.fromEntries(manifest.map(entry => [entry.name, entry.nativeReport]));
const policy = parsePolicy(await readFile(new URL('./web/fixtures/policy.json', import.meta.url), 'utf8'));
const response = () => new Response(Uint8Array.from([1, 2, 3]));
const turn = () => new Promise(resolve => setImmediate(resolve));

test('deployment contains exactly the allowlist, with recorded hashes and no test/state artifacts', async () => {
  const inventory = JSON.parse(await readFile(new URL('./deployment-manifest.json', import.meta.url)));
  const expected = [...appAssets, ...Object.keys(publicExamples).map(name => `examples/${name}`), '_headers'].sort();
  const entries = await readdir(new URL('./dist/', import.meta.url), { recursive: true, withFileTypes: true });
  const actual = entries.filter(entry => entry.isFile()).map(entry => {
    const suffix = entry.parentPath.replaceAll('\\', '/').split('/dist/')[1];
    return suffix ? `${suffix}/${entry.name}` : entry.name;
  }).sort();
  assert.deepEqual(actual, expected);
  assert.deepEqual(inventory.files.map(file => file.path).sort(), expected);
  for (const file of inventory.files) {
    const bytes = await readFile(new URL(`./dist/${file.path}`, import.meta.url));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
});

test('static package retains original, starter and WASM dependency license notices', async () => {
  const [root, starter, original, thirdParty] = await Promise.all([
    readFile(new URL('../../LICENSE', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/LICENSE', import.meta.url), 'utf8'),
    readFile(new URL('./dist/LICENSE.txt', import.meta.url), 'utf8'),
    readFile(new URL('./dist/THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8'),
  ]);
  assert.ok(original.includes(root.trim()));
  assert.ok(original.includes(starter.trim()));
  assert.match(original, /Copyright \(c\) 2026 Stephen Gabriel/);
  for (const text of ['subtle 2.6.1', 'BSD-3-Clause', 'unicode-ident 1.0.27', 'Unicode-3.0',
    'constant_time_eq 0.4.2', 'MIT-0', 'RUST STANDARD LIBRARY', 'The Electric Coin Company',
    'blake2b_simd 1.0.5', '47714dc3c424e82213d7f2eb4a833e3843017be5']) {
    assert.ok(thirdParty.includes(text), `Missing license attribution: ${text}`);
  }
  assert.equal(appAssets.filter(name => name.endsWith('.txt')).length, 2);
});

test('local dist preview serves both license texts without exposing repository files', async () => {
  const preview = staticServer({ directory: fileURLToPath(new URL('./dist/', import.meta.url)), fixtures: false });
  await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${preview.address().port}`;
    for (const name of ['LICENSE.txt', 'THIRD_PARTY_LICENSES.txt']) {
      const response = await fetch(`${origin}/${name}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/plain/);
      assert.equal(await response.text(), await readFile(new URL(`./dist/${name}`, import.meta.url), 'utf8'));
    }
    assert.equal((await fetch(`${origin}/Cargo.lock`)).status, 404);
    assert.equal((await fetch(`${origin}/fixtures/manifest.json`)).status, 404);
  } finally { await new Promise(resolve => preview.close(resolve)); }
});

test('streamed WASM without a length header is cancelled at the byte cap, before compilation', async () => {
  let cancelled = false, compiled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const loader = createWasmLoader({
    fetchImpl: async () => new Response(body),
    compile: async () => { compiled = true; },
  });
  await assert.rejects(loader.load(), /4 MiB/);
  assert.ok(cancelled);
  assert.equal(compiled, false);
});

test('unavailable rows never expose a positive matchesClaim, including matching disclosed values', () => {
  for (const name of ['missing-rseed', 'missing-rcv', 'omitted-commitments', 'compact-memo']) {
    const result = comparePolicy(reports[name], policy);
    assert.ok(result.fields.some(field => field.status === 'unavailable'));
    for (const field of result.fields.filter(field => field.status === 'unavailable')) {
      assert.equal(field.matchesClaim, null, `${name}: ${field.field}`);
    }
  }
});

test('matching output terms do not conceal missing spend or cross-address evidence', () => {
  for (const name of ['missing-fvk', 'missing-cross-address-evidence']) {
    assert.equal(comparePolicy(reports[name], policy).outputStatus, 'matches_proposal');
    assert.equal(disclosureCoverage(reports[name]).status, 'incomplete');
  }
  const missing = disclosureCoverage(reports['missing-fvk']);
  assert.equal(missing.checks.find(check => check.field.endsWith('Spend nullifier')).status, 'unavailable');
  assert.equal(missing.checks.find(check => check.field.endsWith('Randomized key')).status, 'unavailable');
  assert.equal(disclosureCoverage(reports['missing-cross-address-evidence']).checks[1].status, 'unavailable');
});

test('inconsistent spend evidence is separate from matching output-policy terms', () => {
  for (const name of ['altered-spend-rho', 'altered-alpha', 'inconsistent-cross-address']) {
    assert.equal(comparePolicy(reports[name], policy).outputStatus, 'matches_proposal');
    assert.equal(disclosureCoverage(reports[name]).status, 'inconsistent');
  }
});

test('memo authentication states the actual cmx source without upgrading reconstructed evidence', () => {
  const action = reports['omitted-commitments'].actions[0];
  assert.equal(action.noteCommitment.status, 'reconstructed');
  assert.equal(action.memo.status, 'consistent');
  assert.equal(action.memo.cmxSource, 'reconstructed');
  assert.match(action.memo.evidence, /no independent supplied cmx/);
  assert.equal(reports['unsigned-valid-partial'].actions[0].memo.cmxSource, 'supplied');
  assert.equal(reports['compact-memo'].actions[0].memo.status, 'reconstructed');
});

test('strict policy retains exact decimal strings, all ordered outputs and complete memo bytes', () => {
  const report = structuredClone(reports['unsigned-valid-partial']);
  report.actions.push({ ...structuredClone(report.actions[0]), index: 1, amountZat: '200000' });
  const intended = structuredClone(policy);
  intended.outputs.push({ ...intended.outputs[0], amountZat: '200000' });
  assert.equal(comparePolicy(report, parsePolicy(JSON.stringify(intended))).outputStatus, 'matches_proposal');
  intended.outputs.reverse();
  assert.equal(comparePolicy(report, intended).outputStatus, 'mismatch');
  for (const invalid of [
    { ...policy, maxFeeZat: 10000 }, { ...policy, maxFeeZat: '01' },
    { ...policy, outputs: Array(9).fill(policy.outputs[0]) },
    { ...policy, outputs: [{ ...policy.outputs[0], memoHex: '00' }] },
    { ...policy, outputs: [{ ...policy.outputs[0], amountZat: '1e5' }] },
  ]) assert.throws(() => parsePolicy(JSON.stringify(invalid)));
});

test('memo text/hex conversion is explicit, byte-exact and never truncates or normalizes', () => {
  assert.equal(textToMemoHex('a'.repeat(512)), '61'.repeat(512));
  assert.throws(() => textToMemoHex('a'.repeat(513)), /Nothing was truncated/);
  assert.throws(() => textToMemoHex('🙂'.repeat(129)), /Nothing was truncated/);
  for (const text of ['', 'hello\nworld', 'é', 'e\u0301', '\ufeffBOM', '🙂', 'a\0b']) {
    assert.equal(memoHexToText(textToMemoHex(text)), text);
  }
  assert.notEqual(textToMemoHex('é'), textToMemoHex('e\u0301'));
  assert.throws(() => textToMemoHex('\ud800'), /surrogate/);
  assert.throws(() => textToMemoHex('a\r\nb'), /CR\/CRLF/);
  assert.throws(() => memoHexToText('ff'.repeat(512)), /not lossless/);
  assert.throws(() => memoHexToText('0d0a' + '00'.repeat(510)), /CR\/CRLF/);
  assert.throws(() => memoHexToText('00'.repeat(513)), /exactly/);
});

test('memo result previews preserve all bytes and explicitly count possible padding', () => {
  for (const text of ['', 'SYNTHETIC inspector fixture, never broadcast', 'é', 'e\u0301', 'a'.repeat(512)]) {
    const hex = textToMemoHex(text).toUpperCase();
    const detail = describeMemo(hex);
    assert.equal(detail.hex, hex);
    assert.equal(detail.byteLength, 512);
    assert.equal(detail.textByteLength, new TextEncoder().encode(text).length);
    assert.equal(detail.trailingZeroBytes, 512 - detail.textByteLength);
    assert.ok(detail.validUtf8);
  }
  assert.equal(describeMemo('00'.repeat(512)).zeroBytes, 512);
  assert.notEqual(describeMemo(textToMemoHex('é')).hex, describeMemo(textToMemoHex('e\u0301')).hex);
  for (const bad of ['00', '00'.repeat(513), 'gg'.repeat(512)]) assert.throws(() => describeMemo(bad), /exactly 512/);
});

test('memo preview exposes invisible characters without lossy UTF-8 or control rendering', () => {
  const text = 'a\0b\r\n\t \u200b\u202e\u00a0\ufeff';
  const hex = Buffer.from(text).toString('hex').padEnd(1024, '0');
  const memo = describeMemo(hex);
  assert.equal(memo.hex, hex);
  assert.equal(memo.preview, 'a[NUL]b[CR][LF]\n[TAB] [U+200B][U+202E][U+00A0][BOM]');
  for (const name of ['NUL', 'CR', 'LF', 'TAB', 'SPACE', 'U+200B', 'U+202E', 'U+00A0', 'BOM']) {
    assert.deepEqual(memo.invisible.find(entry => entry.name === name), { name, count: 1 });
  }
  const invalid = describeMemo('ff' + '00'.repeat(511));
  assert.equal(invalid.validUtf8, false);
  assert.equal(invalid.preview, null);
  assert.equal(invalid.trailingZeroBytes, 511);
  assert.equal(invalid.hex, 'ff' + '00'.repeat(511));
});

test('plain comparison distinguishes policy differences, inconsistent bindings and unavailable evidence', () => {
  const changedPolicy = structuredClone(policy);
  changedPolicy.outputs[0].amountZat = '99999';
  const mismatch = comparePolicy(reports['unsigned-valid-partial'], changedPolicy);
  assert.ok(mismatch.policyMismatch);
  const row = mismatch.fields.find(field => field.field.endsWith('.amountZat'));
  assert.equal(row.bindingStatus, 'consistent');
  assert.match(explainComparison(row), /differs from your expected policy/);
  assert.doesNotMatch(explainComparison(row), /checks failed/);
  assert.equal(disclosureCoverage(reports['unsigned-valid-partial']).status, 'consistent');
  const altered = comparePolicy(reports['altered-amount'], policy);
  const amount = altered.fields.find(field => field.field.endsWith('.amountZat'));
  assert.deepEqual([amount.expected, amount.actual, amount.valueStatus, amount.bindingStatus, amount.matchesClaim],
    ['100000', '100001', 'mismatch', 'inconsistent', null]);
  assert.match(explainComparison(amount), /Cryptographic disclosure checks failed/);
  const ciphertext = comparePolicy(reports['altered-ciphertext'], policy);
  assert.equal(ciphertext.policyMismatch, false);
  assert.equal(ciphertext.outputStatus, 'mismatch');
  assert.equal(disclosureCoverage(reports['altered-ciphertext']).status, 'inconsistent');
});

test('missing disclosure explanations name the blocked check and never upgrade reconstructed evidence', () => {
  const coverage = disclosureCoverage(reports['missing-fvk']);
  for (const kind of ['nullifier', 'randomizedKey']) {
    const check = coverage.checks.find(check => check.kind === kind);
    const message = explainDisclosure(check);
    assert.match(message, /full viewing key \(FVK\) is missing/);
    assert.match(message, kind === 'nullifier' ? /Cannot recompute the paired spend nullifier/ : /Cannot recompute the randomized spend key/);
    assert.match(message, /No consistent result is claimed/);
  }
  const memo = comparePolicy(reports['omitted-commitments'], policy).fields.find(field => field.field.endsWith('.memoHex'));
  assert.equal(memo.status, 'unavailable');
  assert.equal(memo.matchesClaim, null);
  assert.equal(memo.bindingStatus, 'reconstructed');
  assert.match(explainComparison(memo), /not independently supplied/);
  const recovered = disclosureCoverage(reports['omitted-commitments']).checks.find(check => check.kind === 'memo');
  assert.match(explainDisclosure(recovered), /only against a reconstructed cmx/);
  const compact = disclosureCoverage(reports['compact-memo']).checks.find(check => check.kind === 'memo');
  assert.match(explainDisclosure(compact), /Reconstruction is not verification/);
});

test('WASM fetch and compile share a bounded deadline and late compilation cannot replace retry', async () => {
  let resolveOld;
  let calls = 0;
  const states = [];
  const loader = createWasmLoader({
    fetchImpl: async () => response(), timeoutMs: 10, onState: state => states.push(state),
    compile: () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve('new-module'),
  });
  await assert.rejects(loader.load(), /timed out/);
  const fresh = await loader.load({ retry: true });
  assert.equal(fresh.module, 'new-module');
  resolveOld('obsolete-module');
  await turn();
  assert.equal((await loader.load()).module, 'new-module');
  assert.deepEqual(states, ['loading', 'failed', 'loading', 'ready']);
  const stuckFetch = createWasmLoader({ fetchImpl: () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(stuckFetch.load(), /timed out/);
});

test('WASM HTTP/compile/oversize failures are actionable and retryable', async () => {
  let failed = true;
  const loader = createWasmLoader({
    fetchImpl: async () => failed ? new Response('', { status: 503 }) : response(),
    compile: async () => 'module',
  });
  await assert.rejects(loader.load(), /HTTP 503/);
  failed = false;
  assert.equal((await loader.load({ retry: true })).module, 'module');
  const invalid = createWasmLoader({ fetchImpl: async () => response(), compile: async () => { throw new Error('bad WASM'); } });
  await assert.rejects(invalid.load(), /bad WASM/);
  const oversized = createWasmLoader({ fetchImpl: async () => new Response('x', { headers: { 'content-length': 5 * 1024 * 1024 } }) });
  await assert.rejects(oversized.load(), /4 MiB/);
});

test('cancelling while WASM loads never creates a worker or returns an old result', async () => {
  let release, workers = 0;
  const loaded = new Promise(resolve => { release = resolve; });
  const inspector = createInspector({ loader: { load: () => loaded }, workerFactory: () => { workers++; } });
  const pending = inspector.inspect(new ArrayBuffer(1));
  inspector.cancel();
  release({ module: {}, load: {} });
  await assert.rejects(pending, Cancelled);
  assert.equal(workers, 0);
});

test('worker cancellation, supersession, timeout and postMessage failure all terminate workers', async () => {
  const workers = [];
  const inspector = createInspector({
    loader: { load: async () => ({ module: {}, load: {} }) },
    workerFactory: () => {
      const worker = { terminateCount: 0, terminate() { this.terminateCount++; }, postMessage() {} };
      workers.push(worker); return worker;
    },
  });
  const old = inspector.inspect(new ArrayBuffer(1));
  const oldRejected = assert.rejects(old, Cancelled);
  await turn();
  const staleCallback = workers[0].onmessage;
  const latest = inspector.inspect(new ArrayBuffer(1));
  await turn();
  staleCallback({ data: { report: 'old' } });
  workers[1].onmessage({ data: { report: 'current' } });
  assert.equal((await latest).report, 'current');
  await oldRejected;
  assert.equal(workers[0].terminateCount, 1);
  assert.equal(workers[1].terminateCount, 1);
  await assert.rejects(inspector.inspect(new ArrayBuffer(1), { timeoutMs: 3 }), /timed out/);
  assert.equal(workers[2].terminateCount, 1);
  await assert.rejects(inspector.inspect(new ArrayBuffer(MAX_INPUT + 1)), /256 KiB/);
  let terminated = false;
  const broken = createInspector({
    loader: { load: async () => ({}) }, workerFactory: () => ({
      postMessage() { throw new Error('clone failed'); }, terminate() { terminated = true; },
    }),
  });
  await assert.rejects(broken.inspect(new ArrayBuffer(1)), /clone failed/);
  assert.ok(terminated);
});
