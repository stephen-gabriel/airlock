const encoder = new TextEncoder();
const MEMO_BYTES = 512;

export function textToMemoHex(text) {
  // TextEncoder would otherwise silently replace unpaired UTF-16 surrogates.
  if (!text.isWellFormed()) throw new Error('Memo text contains an unpaired Unicode surrogate. Use exact hex.');
  if (text.includes('\r')) throw new Error('CR/CRLF bytes require hex mode. Text mode uses LF line breaks.');
  const bytes = encoder.encode(text);
  if (bytes.length > MEMO_BYTES) throw new Error(`Memo is ${bytes.length} UTF-8 bytes; maximum 512. Nothing was truncated.`);
  const padded = new Uint8Array(MEMO_BYTES);
  padded.set(bytes);
  return Array.from(padded, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function memoHexToText(hex) {
  if (!/^[0-9a-fA-F]{1024}$/.test(hex)) throw new Error('Hex memo must contain exactly 1024 hex digits (512 bytes), without spaces.');
  const bytes = Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
  let end = bytes.length;
  while (end && bytes[end - 1] === 0) end--;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
  } catch {
    throw new Error('These bytes are not lossless UTF-8 text. Keep hex mode.');
  }
  if (textToMemoHex(text) !== hex.toLowerCase()) throw new Error('These bytes cannot round-trip through text mode. Keep hex mode.');
  return text;
}

// Presentation only. This never supplies equality evidence or changes the original bytes.
export function describeMemo(hex) {
  if (!/^[0-9a-fA-F]{1024}$/.test(hex)) throw new Error('Memo preview requires exactly 512 bytes.');
  const bytes = Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
  let end = bytes.length;
  while (end && bytes[end - 1] === 0) end--;
  const result = {
    hex, byteLength: bytes.length, textByteLength: end,
    trailingZeroBytes: bytes.length - end, zeroBytes: bytes.filter(byte => byte === 0).length,
    validUtf8: false, preview: null, invisible: [],
  };
  try {
    // Keep a leading BOM. Strip only the separately counted trailing zero bytes for display.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
    const counts = new Map();
    const names = { '\0': 'NUL', '\n': 'LF', '\r': 'CR', '\t': 'TAB', '\ufeff': 'BOM' };
    result.preview = Array.from(text, character => {
      if (/[\p{Cc}\p{Cf}\p{Z}]/u.test(character)) {
        const name = character === ' ' ? 'SPACE' : names[character]
          || `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        counts.set(name, (counts.get(name) || 0) + 1);
        if (character !== ' ') return `[${name}]${character === '\n' ? '\n' : ''}`;
      }
      return character;
    }).join('');
    result.validUtf8 = true;
    result.invisible = [...counts].map(([name, count]) => ({ name, count }));
  } catch { /* Invalid UTF-8 has no replacement-character or lossy text fallback. */ }
  return result;
}
