// This worker has no network, storage, signing or wallet API.
self.onmessage = ({ data: { module, bytes } }) => {
  try {
    const start = performance.now();
    const { exports } = new WebAssembly.Instance(module, {});
    if (bytes.byteLength > 256 * 1024) throw new Error('Input exceeds 256 KiB');
    const pointer = exports.input_buffer(bytes.byteLength);
    if (!pointer) throw new Error('Input buffer unavailable');
    new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(new Uint8Array(bytes));
    const checkStart = performance.now();
    const length = exports.inspect_input();
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(exports.memory.buffer, exports.output_buffer(), length),
    ));
    self.postMessage({
      report, instantiateAndInspectMs: performance.now() - start,
      inspectMs: performance.now() - checkStart, memoryBytes: exports.memory.buffer.byteLength,
    });
  } catch {
    self.postMessage({ error: 'Inspector failed or WASM resource limit reached. No verification result.' });
  }
};
