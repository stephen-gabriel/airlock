// Deliberately allowlist files. Never recursively copy the repository or a wallet directory.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appAssets, publicExamples, appCsp, workerCsp } from './static-assets.mjs';
import { parsePolicy } from './web/policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, 'web'), dist = path.join(here, 'dist');
const files = new Map();
const wasm = await readFile(path.join(here, 'target/wasm32-unknown-unknown/release/airlock_browser_inspector_spike.wasm'));
const module = await WebAssembly.compile(wasm);
if (WebAssembly.Module.imports(module).length) throw new Error('WASM must have no runtime imports.');
for (const name of appAssets) files.set(name, name === 'inspector.wasm' ? wasm : await readFile(path.join(web, name)));
const fixtures = path.join(web, 'fixtures');
const manifest = JSON.parse(await readFile(path.join(fixtures, 'manifest.json'), 'utf8'));
for (const [name, source] of Object.entries(publicExamples)) {
  const bytes = await readFile(path.join(fixtures, source));
  if (name === 'policy.json') parsePolicy(bytes.toString('utf8'));
  else {
    const fixture = manifest.find(entry => `${entry.name}.bin` === source);
    if (!fixture || fixture.bytes !== bytes.length || fixture.nativeReport.scope !== 'supported'
      || fixture.nativeReport.metadata.hasIronwoodProof
      || fixture.nativeReport.actions.some(action => action.hasSpendSignature)) {
      throw new Error(`Refusing unexpected non-synthetic/unsigned fixture: ${source}. Run the deterministic generator.`);
    }
  }
  files.set(`examples/${name}`, bytes);
}
files.set('_headers', Buffer.from(`/*\n  Content-Security-Policy: ${appCsp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n/worker.js\n  Content-Security-Policy: ${workerCsp}\n/inspector.wasm\n  Content-Type: application/wasm\n`));
// Do not silently delete unknown content or user additions in an existing output directory.
try {
  const existing = await readdir(dist, { recursive: true, withFileTypes: true });
  for (const entry of existing) {
    const relative = path.relative(dist, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (!entry.isDirectory() && !files.has(relative)) throw new Error(`Unexpected deployment file ${relative}; refusing to overwrite or delete user work.`);
    if (entry.isDirectory() && !['assets', 'examples'].includes(relative)) throw new Error(`Unexpected deployment directory ${relative}; refusing to change it.`);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const [name, bytes] of files) {
  const destination = path.join(dist, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
await mkdir(path.join(web, 'examples'), { recursive: true });
await writeFile(path.join(web, 'inspector.wasm'), wasm);
for (const name of Object.keys(publicExamples)) await writeFile(path.join(web, 'examples', name), files.get(`examples/${name}`));
const inventory = [...files].map(([name, bytes]) => ({
  path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
}));
await writeFile(path.join(here, 'deployment-manifest.json'), JSON.stringify({
  directory: 'experiments/browser-inspector/dist', publicSyntheticExamples: Object.keys(publicExamples),
  files: inventory,
}, null, 2) + '\n');
console.log(`Prepared ${inventory.length} allowlisted static files in ${dist}`);
