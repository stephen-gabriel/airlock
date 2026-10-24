export const MAX_INPUT = 256 * 1024;
const MAX_WASM = 4 * 1024 * 1024;

export class Cancelled extends Error {
  constructor() { super('Inspection cancelled because inputs changed.'); this.name = 'Cancelled'; }
}

// Injection is for focused tests. Production uses only static same-origin assets.
export function createWasmLoader({
  fetchImpl = (...args) => fetch(...args), compile = bytes => WebAssembly.compile(bytes),
  timeoutMs = 15000, onState = () => {},
} = {}) {
  let current, cached;
  return {
    load({ retry = false } = {}) {
      if (retry) { current?.cancel(); cached = undefined; }
      if (cached) return Promise.resolve(cached);
      if (current) return current.promise;
      const attempt = {};
      const controller = new AbortController();
      let timer;
      const start = performance.now();
      attempt.promise = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (current !== attempt) { reject(new Cancelled()); return; }
          current = undefined;
          if (error) {
            onState('failed', error.message);
            reject(error);
          } else {
            cached = value;
            onState('ready');
            resolve(value);
          }
        };
        attempt.cancel = () => { controller.abort(); finish(new Cancelled()); };
        timer = setTimeout(() => {
          controller.abort();
          finish(new Error('Checker loading timed out. Retry loading the local WASM asset.'));
        }, timeoutMs);
        // Start in a microtask so current is assigned even for immediate mock failures.
        Promise.resolve().then(async () => {
          const response = await fetchImpl('./inspector.wasm', { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
          if (!response.ok) throw new Error(`Checker asset unavailable (HTTP ${response.status}). Build or serve the static app, then retry.`);
          const declared = Number(response.headers.get('content-length'));
          if (declared > MAX_WASM) throw new Error('Checker asset exceeds the 4 MiB loading limit.');
          let bytes;
          if (response.body) {
            const reader = response.body.getReader();
            const chunks = [];
            let length = 0;
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > MAX_WASM) {
                  await reader.cancel();
                  throw new Error('Checker asset exceeds the 4 MiB loading limit.');
                }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
            const joined = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
            bytes = joined.buffer;
          } else {
            bytes = await response.arrayBuffer();
          }
          if (!bytes.byteLength || bytes.byteLength > MAX_WASM) throw new Error('Checker asset is empty or exceeds the 4 MiB loading limit.');
          const module = await compile(bytes);
          return { module, load: { wasmBytes: bytes.byteLength, fetchAndCompileMs: performance.now() - start } };
        }).then(value => finish(null, value), error => finish(error));
      });
      current = attempt;
      onState('loading');
      return attempt.promise;
    },
  };
}

export function createInspector({ loader, workerFactory = () => new Worker('./worker.js', { type: 'module' }) }) {
  let generation = 0, stop;
  const cancel = () => { generation++; stop?.(); };
  return {
    cancel,
    async inspect(bytes, { timeoutMs = 15000 } = {}) {
      cancel();
      const token = generation;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_INPUT) throw new Error('Input exceeds 256 KiB or is not a byte buffer.');
      const loaded = await loader.load();
      if (token !== generation) throw new Cancelled();
      const result = await new Promise((resolve, reject) => {
        let worker, timer, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
          }
          if (stop === cancelJob) stop = undefined;
          if (error) reject(error); else resolve(value);
        };
        const cancelJob = () => finish(new Cancelled());
        stop = cancelJob;
        timer = setTimeout(() => finish(new Error('Inspection timed out. No result was retained. Try a smaller supported proposal.')), timeoutMs);
        try {
          worker = workerFactory();
          worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data);
          worker.onerror = event => { event.preventDefault(); finish(new Error('Checker worker failed. No result was retained. Retry the inspection.')); };
          worker.postMessage({ module: loaded.module, bytes }, [bytes]);
        } catch (error) { finish(error); }
      });
      if (token !== generation) throw new Cancelled();
      return { ...result, load: loaded.load };
    },
  };
}
