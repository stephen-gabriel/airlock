#!/usr/bin/env node
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('usage: refresh-health.mjs <worker.sock>\n');
  process.exit(2);
}

let settled = false;
const socket = net.createConnection({ path: socketPath });
const timer = setTimeout(() => {
  finish(1, 'worker response timeout\n');
}, 180_000);

function finish(code, output) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (output) process.stderr.write(output);
  socket.destroy();
  process.exitCode = code;
}

let buffer = '';
socket.setEncoding('utf8');
socket.on('connect', () => {
  socket.write(`${JSON.stringify({ cmd: 'sync' })}\n`);
});
socket.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) {
    finish(1, 'worker response too large\n');
    return;
  }
  const newline = buffer.indexOf('\n');
  if (newline === -1) return;
  const line = buffer.slice(0, newline);
  try {
    const result = JSON.parse(line);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    finish(result.ok === true ? 0 : 1);
  } catch {
    finish(1, 'worker returned invalid JSON\n');
  }
});
socket.on('error', (error) => {
  finish(1, `${error.message}\n`);
});
socket.on('close', () => {
  if (!settled) finish(1, 'worker closed the connection\n');
});
