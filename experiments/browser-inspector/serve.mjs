import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appAssets, publicExamples, appCsp, workerCsp } from './static-assets.mjs';

const web = fileURLToPath(new URL('./web/', import.meta.url));
export function staticServer({ directory = web, fixtures = directory === web } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Serve only known static source files and disposable fixtures. Never accept uploads.
    const allowed = appAssets.includes(relative)
      || Object.keys(publicExamples).some(name => relative === `examples/${name}`)
      || (fixtures && /^fixtures\/[a-z0-9-]+\.(bin|json)$/.test(relative));
    if (request.method !== 'GET' || !allowed || url.search) {
      response.writeHead(404); response.end(); return;
    }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
    const csp = relative === 'worker.js'
      ? workerCsp : appCsp;
    try {
      const bytes = await readFile(path.join(directory, relative));
      response.writeHead(200, {
        'Content-Type': types[path.extname(relative)], 'Cache-Control': 'no-store',
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404); response.end();
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv.includes('--dist') ? fileURLToPath(new URL('./dist/', import.meta.url)) : web;
  staticServer({ directory }).listen(8089, '127.0.0.1', () => console.log(`Static files only: http://127.0.0.1:8089 (${directory})`));
}
