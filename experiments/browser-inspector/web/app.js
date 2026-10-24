import { parsePolicy, comparePolicy, disclosureCoverage } from './policy.js';
import { createWasmLoader, createInspector, Cancelled, MAX_INPUT } from './engine.js';
import { createPolicyForm } from './form.js';
import { renderReport, setResultState } from './view.js';

export { MAX_INPUT, renderReport };
const $ = selector => document.querySelector(selector);
let proposal, revision = 0, busy = false, exampleRequest, checkerState = 'loading';
const examples = {
  matching: { file: 'matching.bin', name: 'Synthetic · matching terms', note: 'Public synthetic unsigned partial. All implemented supplied-field checks can run; no real funding or transaction validity is established.' },
  altered: { file: 'altered.bin', name: 'Synthetic · altered amount', note: 'Loaded: public synthetic unsigned partial, amount changed to 100,001 zat; intended policy stays 100,000 zat. Review the policy, then Inspect locally to check the actual differences and commitments.' },
  missing: { file: 'missing.bin', name: 'Synthetic · missing spend disclosure', note: 'Loaded: public synthetic unsigned partial with no spend full viewing key (FVK). Inspect locally to see output terms separately from the nullifier and randomized-key checks that cannot run.' },
};
const updateButton = () => {
  $('#inspect').disabled = busy || !proposal || checkerState !== 'ready';
  $('#inspect').setAttribute('aria-busy', String(busy));
};
const loader = createWasmLoader({
  onState(state, message) {
    checkerState = state;
    $('.engine-status').dataset.state = state;
    $('#status').textContent = ({ loading: 'Loading local checker…', ready: 'Local checker ready', failed: 'Checker unavailable' })[state];
    $('#retry-wasm').hidden = state !== 'failed';
    if (state === 'failed') setResultState('error', 'The local checker could not load', `${message} No inspection result is available.`);
    updateButton();
  },
});
const inspector = createInspector({ loader });
function activeStep(href) {
  document.querySelectorAll('.nav a').forEach(link => {
    if (link.getAttribute('href') === href) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });
}

function invalidate(title = 'Inputs changed. Inspect again.', description = 'Previous results were cleared. The next inspection will use the current proposal and intended policy.') {
  revision++; inspector.cancel(); exampleRequest?.abort(); exampleRequest = undefined; busy = false;
  setResultState('empty', title, description); updateButton();
}
const form = createPolicyForm(() => { invalidate(); activeStep('#intended-policy'); });
const announceProposal = () => {
  $('#filename').textContent = proposal?.name || 'No proposal loaded';
  $('#file-size').textContent = proposal ? `${proposal.size.toLocaleString()} bytes · local` : '256 KiB maximum';
  document.querySelectorAll('[data-example]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.example === proposal?.example));
  });
};
function setFile(file) {
  activeStep('#load');
  invalidate('Proposal loaded. Set the intended policy.', 'No inspection has run. Enter your expected terms, then choose Inspect locally.');
  if (!file) { proposal = undefined; announceProposal(); return; }
  if (file.size > MAX_INPUT) {
    proposal = undefined; $('#pczt').value = ''; announceProposal(); updateButton();
    setResultState('error', 'This file is too large', 'Input exceeds 256 KiB. No file bytes were read and no comparison was made.');
    return;
  }
  proposal = { file, name: file.name, size: file.size };
  $('#example-note').textContent = 'Your local file is not uploaded. PCZTs may contain private disclosures; the page, WASM and browser remain trust boundaries.';
  announceProposal(); updateButton();
}
$('#pczt').addEventListener('change', () => setFile($('#pczt').files[0]));
const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', event => {
  event.preventDefault(); dropzone.classList.remove('dragging');
  $('#pczt').value = '';
  if (event.dataTransfer.files.length !== 1) {
    invalidate(); proposal = undefined; announceProposal(); updateButton();
    setResultState('error', 'Choose one proposal at a time', 'Drop exactly one PCZT file. No comparison was made.'); return;
  }
  setFile(event.dataTransfer.files[0]);
});

export async function loadExample(key) {
  if (!Object.hasOwn(examples, key)) throw new Error('Unknown synthetic example');
  invalidate('Loading a public synthetic example…', 'Fetching only the selected public static sample and its intended policy.');
  activeStep('#load');
  const token = revision;
  const controller = new AbortController(); exampleRequest = controller;
  busy = true; updateButton();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const get = async name => {
      const response = await fetch(`./examples/${name}`, { credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error(`Synthetic example unavailable (HTTP ${response.status}). Rebuild the static examples or choose a local file.`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_INPUT) throw new Error('Synthetic example exceeds the input limit.');
      return bytes;
    };
    const [bytes, policyBytes] = await Promise.all([get(examples[key].file), get('policy.json')]);
    if (token !== revision) throw new Cancelled();
    const policy = parsePolicy(new TextDecoder('utf-8', { fatal: true }).decode(policyBytes));
    form.setPolicy(policy, { preferText: true });
    proposal = { bytes, name: examples[key].name, size: bytes.byteLength, example: key };
    $('#pczt').value = '';
    $('#example-note').textContent = examples[key].note;
    announceProposal();
    setResultState('empty', 'Synthetic example loaded. Ready to inspect.', 'The example label is not a result. Choose Inspect locally to run the real WASM checker.');
  } catch (error) {
    if (token === revision && !(error instanceof Cancelled)) setResultState('error', 'The synthetic example could not load',
      error.name === 'AbortError' ? 'Example loading timed out. Try the example again, or choose a local file.' : error.message);
  } finally {
    clearTimeout(timer);
    if (token === revision) { busy = false; exampleRequest = undefined; updateButton(); }
  }
}
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => loadExample(button.dataset.example)));

function begin() {
  invalidate('Inspecting disclosed fields…', 'Running the local upstream WASM checker. This does not check proof validity, funding or authorization.');
  busy = true; $('#results').dataset.state = 'loading'; $('#results').setAttribute('aria-busy', 'true');
  $('#result-chip').textContent = 'Inspecting…'; updateButton(); return revision;
}
async function inspectCurrent(bytes, policyText, options, token) {
  try {
    const policy = parsePolicy(policyText);
    const result = await inspector.inspect(bytes, options);
    if (token !== revision) throw new Cancelled();
    const value = { ...result, comparison: comparePolicy(result.report, policy), coverage: disclosureCoverage(result.report) };
    renderReport(value); activeStep('#results'); return value;
  } catch (error) {
    if (token === revision && !(error instanceof Cancelled)) {
      setResultState('error', 'No inspection result is available', error.message);
    }
    throw error;
  } finally {
    if (token === revision) { busy = false; updateButton(); }
  }
}
export async function inspectBytes(bytes, policyText, options = {}) {
  return inspectCurrent(bytes, policyText, options, begin());
}
async function inspectFile() {
  const token = begin();
  try {
    if (!proposal) throw new Error('Load a local proposal or a public synthetic example first.');
    const policyText = form.getPolicyText();
    if (proposal.size > MAX_INPUT) throw new Error('Input exceeds 256 KiB.');
    const bytes = proposal.bytes ? proposal.bytes.slice(0) : await proposal.file.arrayBuffer();
    if (token !== revision) throw new Cancelled();
    await inspectCurrent(bytes, policyText, {}, token);
    if (token === revision) $('#results').focus({ preventScroll: true });
  } catch (error) {
    if (token === revision && !(error instanceof Cancelled)) setResultState('error', 'Inspection did not complete', error.message);
  } finally {
    if (token === revision) { busy = false; updateButton(); }
  }
}
$('#inspect').addEventListener('click', inspectFile);
$('#clear').addEventListener('click', () => {
  invalidate('Workspace cleared', 'File selection, intended policy and results were removed. Browser memory erasure is not guaranteed.');
  proposal = undefined; $('#pczt').value = ''; form.reset(); announceProposal(); updateButton();
  activeStep('#load');
  $('#example-note').textContent = 'Examples load public synthetic unsigned partials and intended policy. No real funds or chain-valid transaction.';
});
$('#retry-wasm').addEventListener('click', async () => {
  invalidate('Retrying the local checker…', 'Only the static WASM asset is fetched. No proposal or policy is uploaded.');
  const token = revision;
  try {
    await loader.load({ retry: true });
    if (token === revision) setResultState('empty', 'Local checker ready', 'No inspection has run since the retry. Load a proposal or inspect the current inputs.');
  }
  catch { /* loader state supplies the actionable failure */ }
});
// Anchors are actual workflow sections, not retained payment/dashboard pages.
document.querySelectorAll('.nav a').forEach(link => link.addEventListener('click', () => {
  activeStep(link.getAttribute('href'));
}));
updateButton();
loader.load().catch(() => { /* load failure is displayed with retry, never unhandled */ });
