export const appAssets = [
  'index.html', 'style.css', 'app.js', 'engine.js', 'form.js', 'view.js',
  'memo.js', 'policy.js', 'worker.js', 'inspector.wasm',
  'assets/airlock-mark.svg', 'assets/inspector-boundary.svg',
  'LICENSE.txt', 'THIRD_PARTY_LICENSES.txt',
];
export const publicExamples = {
  'matching.bin': 'unsigned-valid-partial.bin',
  'altered.bin': 'altered-amount.bin',
  'missing.bin': 'missing-fvk.bin',
  'policy.json': 'policy.json',
};
export const appCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const workerCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'";
