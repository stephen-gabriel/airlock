import { disclosureCoverage, explainComparison, explainDisclosure } from './policy.js';
import { describeMemo } from './memo.js';

const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const labels = {
  consistent: 'Supplied · consistent', reconstructed: 'Reconstructed',
  unavailable: 'Unavailable', inconsistent: 'Inconsistent', not_applicable: 'Not applicable',
  matches: 'Policy matches', mismatch: 'Policy mismatch',
};
const fieldName = field => ({
  coinTypeClaim: 'Coin-type claim', branchId: 'Branch ID', expiryHeight: 'Expiry bound',
  outputCount: 'Action outputs', maxFeeZat: 'Conditional fee · zat',
}[field] || field.replace(/output\[(\d+)\]/, (_, index) => `Output ${Number(index) + 1}`)
  .replace('.recipientRaw', ' · receiver').replace('.amountZat', ' · amount (zat)').replace('.memoHex', ' · memo'));

export function setResultState(kind, title, description) {
  const results = $('#results');
  results.dataset.state = kind; results.setAttribute('aria-busy', String(kind === 'loading'));
  $('#result-summary').textContent = title;
  $('#result-description').textContent = description;
  const chip = $('#result-chip');
  chip.textContent = ({ empty: 'Not inspected', loading: 'Inspecting…', match: 'Terms match',
    incomplete: 'Incomplete evidence', mismatch: 'Differences found', unsupported: 'Unsupported', error: 'No result' })[kind];
  chip.dataset.tone = kind;
  $('#result-contents').hidden = true; $('#technical').hidden = true;
  $('#result').textContent = '';
  $('#result-overview').replaceChildren(); $('#comparison').replaceChildren();
  $('#metadata-comparison').replaceChildren(); $('#coverage').replaceChildren();
  $('#announcer').textContent = title;
}

function valueNode(value, field) {
  if (value === null || value === undefined) return node('span', 'Not disclosed / not recoverable', 'muted');
  if (field.endsWith('.memoHex')) {
    const memo = describeMemo(String(value));
    const box = node('div', undefined, 'memo-value');
    box.dataset.validUtf8 = String(memo.validUtf8);
    box.append(node('p', memo.validUtf8 ? 'UTF-8 preview · display only' : 'No valid UTF-8 text preview', 'memo-preview-label'));
    if (memo.validUtf8) {
      box.append(node('pre', memo.preview || '(No text before trailing zero bytes)', 'memo-preview'));
    } else {
      box.append(node('p', 'These bytes are not valid UTF-8. No replacement or lossy preview is shown.', 'helper'));
    }
    box.append(node('p', `512 bytes total · ${memo.textByteLength}-byte prefix + ${memo.trailingZeroBytes} trailing 0x00 bytes.`, 'memo-byte-count'));
    const invisible = node('details', undefined, 'memo-invisible');
    invisible.append(node('summary', 'Padding & invisible bytes'));
    invisible.append(node('p', `${memo.trailingZeroBytes} trailing zero bytes may be padding; their intent is unknown. They remain part of the exact memo. ${memo.zeroBytes} zero bytes in total.`));
    invisible.append(node('p', memo.validUtf8
      ? `Before trailing zeros: ${memo.invisible.length ? memo.invisible.map(item => `${item.name}: ${item.count}`).join('; ') : 'no spaces or invisible characters'}. Non-printing characters are shown as bracketed tokens; ordinary spaces remain spaces.`
      : 'Invisible-character interpretation is unavailable because UTF-8 decoding failed. Inspect the exact hex.'));
    box.append(invisible);
    const details = node('details', undefined, 'long-value');
    details.append(node('summary', 'Exact hex · 512 bytes / 1,024 digits'), node('code', memo.hex));
    box.append(details, node('p', 'Only the original 512 bytes are used for equality. This preview is not equality evidence.', 'memo-caution'));
    return box;
  }
  return node('code', String(value));
}

function comparisonTable(fields) {
  const table = node('table', undefined, 'comparison');
  const caption = node('caption', 'Entered policy compared to disclosed proposal', 'sr-only');
  table.append(caption);
  const head = node('thead'), heading = node('tr');
  for (const title of ['Field', 'Expected', 'Disclosed', 'What this means']) {
    const th = node('th', title); th.scope = 'col'; heading.append(th);
  }
  head.append(heading); table.append(head);
  const body = node('tbody');
  for (const field of fields) {
    const row = node('tr', undefined, field.bindingStatus === 'inconsistent' ? 'inconsistent' : field.status);
    row.dataset.field = field.field;
    const name = node('td', fieldName(field.field));
    const expected = node('td'), actual = node('td'), evidence = node('td');
    expected.dataset.label = 'Expected'; actual.dataset.label = 'Disclosed'; evidence.dataset.label = 'What this means';
    expected.append(valueNode(field.expected, field.field)); actual.append(valueNode(field.actual, field.field));
    const badgeStatus = field.bindingStatus === 'inconsistent' ? 'inconsistent'
      : field.bindingStatus === 'reconstructed' ? 'reconstructed' : field.status;
    evidence.append(node('span', badgeStatus === 'inconsistent' ? 'Disclosure inconsistency'
      : labels[badgeStatus] || badgeStatus, `evidence-badge ${badgeStatus}`));
    evidence.append(node('span', explainComparison(field), 'row-note'));
    row.append(name, expected, actual, evidence); body.append(row);
  }
  table.append(body); return table;
}

export function renderReport(value) {
  const { report, comparison } = value;
  const coverage = value.coverage || disclosureCoverage(report);
  if (!report.parsed) {
    setResultState('error', 'This file could not be parsed', report.error || 'Malformed PCZT. No comparison was made.');
  } else if (report.scope !== 'supported') {
    setResultState(report.scope === 'unsupported' ? 'unsupported' : 'error',
      report.scope === 'unsupported' ? 'Outside this checker’s scope' : 'These fields could not be checked',
      report.reason || 'Only pre-release NU7 V6 Ironwood-only proposals with 1–8 actions are supported.');
  } else {
    const outputStatus = comparison.outputStatus;
    const outputMatch = outputStatus === 'matches_proposal';
    const evidenceIncomplete = coverage.status === 'incomplete';
    const evidenceBad = coverage.status === 'inconsistent';
    const policyDiffers = comparison.policyMismatch;
    const outputDiffers = comparison.disclosedOutputStatus === 'mismatch';
    const kind = policyDiffers || evidenceBad ? 'mismatch'
      : !outputMatch || evidenceIncomplete ? 'incomplete' : 'match';
    const title = policyDiffers && evidenceBad ? 'Policy values differ and disclosure checks fail'
      : policyDiffers ? outputDiffers ? 'The proposal differs from your policy' : 'Metadata differs from your policy'
      : evidenceBad ? 'Disclosure checks found inconsistencies'
        : outputMatch && evidenceIncomplete ? 'Output terms match. Evidence is incomplete.'
          : outputMatch ? 'Output terms match your intended policy'
            : 'Some output terms cannot be compared';
    setResultState(kind, title, 'This is a comparison of the supplied proposal, not approval or proof of transaction validity. Review both sections below.');
    $('#result-contents').hidden = false;
    const tile = (label, detail, tone) => {
      const box = node('div', undefined, `overview-tile ${tone || ''}`);
      box.append(node('p', label), node('strong', detail)); return box;
    };
    $('#result-overview').append(
      tile('Output-policy terms', outputDiffers ? 'Disclosed values differ' : outputMatch ? 'Match entered terms' : 'Not fully checkable',
        outputDiffers ? 'mismatch' : outputMatch ? '' : 'incomplete'),
      tile('Disclosure-check coverage', coverage.status === 'consistent' ? 'Supplied checks consistent'
        : evidenceBad ? 'Inconsistencies found' : 'Missing / reconstructed evidence',
        evidenceBad ? 'mismatch' : evidenceIncomplete ? 'incomplete' : ''),
    );
    $('#comparison').append(comparisonTable(comparison.fields.filter(field => field.group === 'outputs')));
    $('#metadata-comparison').append(comparisonTable(comparison.fields.filter(field => field.group === 'metadata')));
    const grid = node('div', undefined, 'coverage-grid');
    for (const check of coverage.checks) {
      const row = node('div', undefined, 'coverage-row');
      row.dataset.evidence = check.status;
      const head = node('div');
      const derivedMemo = check.kind === 'memo' && check.cmxSource === 'reconstructed' && check.status === 'consistent';
      head.append(node('strong', check.field), node('span', derivedMemo ? 'Ciphertext consistent · derived cmx'
        : labels[check.status] || check.status, `evidence-badge ${derivedMemo ? 'reconstructed' : check.status}`));
      row.append(head, node('p', explainDisclosure(check)));
      const detail = node('details', undefined, 'checker-detail');
      detail.append(node('summary', 'Checker detail'), node('code', check.reason || check.evidence || 'No independent supplied evidence.'));
      row.append(detail);
      grid.append(row);
    }
    $('#coverage').append(grid);
  }
  $('#technical').hidden = false;
  $('#result').textContent = JSON.stringify({ ...value, coverage }, null, 2);
}
