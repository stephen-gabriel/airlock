import { parsePolicy } from './policy.js';
import { textToMemoHex, memoHexToText } from './memo.js';

const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const blankOutput = () => ({ recipientRaw: '', amountZat: '', memoHex: '00'.repeat(512), mode: 'text', text: '' });
const uint = (value, name) => {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value) > 0xffffffff) throw new Error(`${name} must be a uint32 decimal integer, without spaces or leading zeros.`);
  return Number(value);
};

export function createPolicyForm(onChange) {
  let outputs = [blankOutput()];
  let source = 'form';
  const error = message => {
    $('#policy-error').textContent = message || '';
    $('#policy-error').hidden = !message;
    $('#policy').setAttribute('aria-invalid', String(Boolean(message)));
  };
  const build = () => {
    const policy = {
      coinTypeClaim: uint($('#coin-type').value, 'Coin-type claim'),
      branchId: $('#branch-id').value,
      minExpiry: uint($('#min-expiry').value, 'Minimum expiry'),
      maxExpiry: uint($('#max-expiry').value, 'Maximum expiry'),
      maxFeeZat: $('#max-fee').value,
      outputs: outputs.map((output, index) => {
        if (!/^[0-9a-fA-F]{86}$/.test(output.recipientRaw)) throw new Error(`Output ${index + 1}: enter exactly 86 raw receiver hex digits, without spaces. Unified Addresses are not supported.`);
        if (!/^(0|[1-9][0-9]{0,15})$/.test(output.amountZat)) throw new Error(`Output ${index + 1}: amount must be an exact decimal zat string, without spaces, signs or exponents.`);
        return {
          recipientRaw: output.recipientRaw, amountZat: output.amountZat,
          memoHex: output.mode === 'text' ? textToMemoHex(output.text) : output.memoHex,
        };
      }),
    };
    return parsePolicy(JSON.stringify(policy));
  };
  const sync = () => {
    source = 'form';
    try { $('#policy').value = JSON.stringify(build(), null, 2); error(); }
    catch (failure) { error(failure.message); }
  };
  const changed = () => { onChange(); sync(); };

  function renderOutputs() {
    const container = $('#outputs');
    container.replaceChildren();
    outputs.forEach((output, index) => {
      const prefix = `output-${index}`;
      const fieldset = node('fieldset', undefined, 'output-editor');
      fieldset.append(node('legend', `Output ${String(index + 1).padStart(2, '0')}`));
      const toolbar = node('div', undefined, 'output-toolbar');
      toolbar.append(node('p', 'Action order is policy order.'));
      const tools = node('div', undefined, 'output-tools');
      for (const [label, glyph, disabled, act] of [
        ['Move up', '↑', index === 0, () => { [outputs[index - 1], outputs[index]] = [outputs[index], outputs[index - 1]]; }],
        ['Move down', '↓', index === outputs.length - 1, () => { [outputs[index], outputs[index + 1]] = [outputs[index + 1], outputs[index]]; }],
        ['Remove', '−', outputs.length === 1, () => outputs.splice(index, 1)],
      ]) {
        const button = node('button', glyph, 'icon-btn');
        button.type = 'button'; button.disabled = disabled;
        button.setAttribute('aria-label', `${label} output ${index + 1}`);
        button.addEventListener('click', () => { act(); changed(); renderOutputs(); $('#add-output').focus(); });
        tools.append(button);
      }
      toolbar.append(tools); fieldset.append(toolbar);
      const inputField = (key, labelText, tag, className, rows) => {
        const label = node('label', labelText, `field ${key === 'amountZat' ? 'output-amount' : ''}`);
        const input = node(tag, undefined, className);
        input.id = `${prefix}-${key}`; input.value = output[key];
        label.htmlFor = input.id; input.autocomplete = 'off'; input.spellcheck = false;
        if (rows) input.rows = rows;
        if (key === 'amountZat') input.inputMode = 'numeric';
        input.addEventListener('input', () => { output[key] = input.value; changed(); });
        label.append(input); fieldset.append(label);
      };
      inputField('recipientRaw', 'Raw receiver · 43 bytes / 86 hex digits', 'textarea', 'receiver', 3);
      inputField('amountZat', 'Amount · exact decimal zat string', 'input', 'mono');

      const head = node('div', undefined, 'memo-head');
      const label = node('label', 'Memo · compare all 512 bytes');
      label.htmlFor = `${prefix}-memo`;
      const mode = node('select');
      mode.setAttribute('aria-label', `Memo encoding for output ${index + 1}`);
      for (const [value, title] of [['text', 'UTF-8 text + explicit zero padding'], ['hex', 'Exact 512-byte hex']]) {
        const option = node('option', title); option.value = value; mode.append(option);
      }
      mode.value = output.mode;
      head.append(label, mode); fieldset.append(head);
      const memo = node('textarea', undefined, 'memo-input');
      memo.id = `${prefix}-memo`; memo.spellcheck = false; memo.rows = output.mode === 'hex' ? 4 : 3;
      memo.value = output.mode === 'text' ? output.text : output.memoHex;
      const hint = node('p', undefined, 'memo-hint');
      hint.id = `${prefix}-hint`; memo.setAttribute('aria-describedby', hint.id);
      const updateHint = () => {
        try {
          if (output.mode === 'text') {
            textToMemoHex(output.text);
            hint.textContent = `${new TextEncoder().encode(output.text).length} / 512 UTF-8 bytes. Remaining bytes are explicitly zero-padded. LF line breaks; no Unicode normalization. Use hex for CR/CRLF or arbitrary bytes.`;
          } else {
            if (!/^[0-9a-fA-F]{1024}$/.test(output.memoHex)) throw new Error(`${output.memoHex.length} / 1024 hex digits. Exactly 512 bytes required; no spaces, truncation or padding in hex mode.`);
            hint.textContent = '512 exact bytes. No trimming, normalization or automatic padding.';
          }
          hint.classList.remove('error'); memo.setAttribute('aria-invalid', 'false');
        } catch (failure) {
          hint.textContent = failure.message; hint.classList.add('error'); memo.setAttribute('aria-invalid', 'true');
        }
      };
      memo.addEventListener('input', () => {
        if (output.mode === 'text') output.text = memo.value; else output.memoHex = memo.value;
        changed(); updateHint();
      });
      memo.addEventListener('paste', event => {
        if (output.mode === 'text' && event.clipboardData?.getData('text').includes('\r')) {
          event.preventDefault();
          hint.textContent = 'Paste rejected: CR/CRLF would be normalized by a textarea. Use hex mode to preserve those bytes.';
          hint.classList.add('error');
        }
      });
      mode.addEventListener('change', () => {
        onChange();
        try {
          if (mode.value === 'text') output.text = memoHexToText(output.memoHex);
          else output.memoHex = textToMemoHex(output.text);
          output.mode = mode.value;
          sync(); renderOutputs(); $(`#${prefix}-memo`).focus();
        } catch (failure) { mode.value = output.mode; error(failure.message); }
      });
      fieldset.append(memo, hint); updateHint(); container.append(fieldset);
    });
    $('#add-output').disabled = outputs.length >= 8;
  }

  function setPolicy(policy, { preferText = false, updateJson = true } = {}) {
    const checked = parsePolicy(JSON.stringify(policy));
    for (const [id, key] of [['coin-type', 'coinTypeClaim'], ['branch-id', 'branchId'], ['min-expiry', 'minExpiry'], ['max-expiry', 'maxExpiry'], ['max-fee', 'maxFeeZat']]) $(`#${id}`).value = String(checked[key]);
    outputs = checked.outputs.map(output => {
      const entry = { ...output, mode: 'hex', text: '' };
      if (preferText) {
        try { entry.text = memoHexToText(entry.memoHex); entry.mode = 'text'; } catch { /* preserve arbitrary bytes in hex */ }
      }
      return entry;
    });
    if (updateJson) $('#policy').value = JSON.stringify(checked, null, 2);
    source = updateJson ? 'form' : 'json'; renderOutputs(); error();
  }
  for (const id of ['coin-type', 'branch-id', 'min-expiry', 'max-expiry', 'max-fee']) $(`#${id}`).addEventListener('input', changed);
  $('#add-output').addEventListener('click', () => {
    if (outputs.length >= 8) return;
    outputs.push(blankOutput()); changed(); renderOutputs();
    $(`#output-${outputs.length - 1}-recipientRaw`).focus();
  });
  $('#policy').addEventListener('input', () => {
    onChange(); source = 'json';
    try { setPolicy(parsePolicy($('#policy').value), { updateJson: false }); }
    catch (failure) { error(failure.message); }
  });
  renderOutputs();
  // The empty form intentionally remains incomplete until the user enters intended terms.
  $('#policy').value = JSON.stringify({
    coinTypeClaim: 1, branchId: '77190ad9', minExpiry: 0, maxExpiry: 4600000,
    maxFeeZat: '10000', outputs: [{ recipientRaw: '', amountZat: '', memoHex: '00'.repeat(512) }],
  }, null, 2);
  return {
    setPolicy,
    getPolicyText() {
      try {
        const checked = source === 'json' ? parsePolicy($('#policy').value) : build();
        error(); return JSON.stringify(checked);
      } catch (failure) { error(failure.message); throw failure; }
    },
    reset() {
      outputs = [blankOutput()]; source = 'form';
      $('#max-fee').value = '10000'; $('#coin-type').value = '1';
      $('#branch-id').value = '77190ad9'; $('#min-expiry').value = '0'; $('#max-expiry').value = '4600000';
      $('#policy').value = ''; renderOutputs(); error();
    },
  };
}
