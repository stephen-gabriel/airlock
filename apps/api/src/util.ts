import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const nowIso = (): string => new Date().toISOString();
export const nowUnix = (): number => Math.floor(Date.now() / 1000);

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isSafeId(value: unknown, max = 64): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return false;
  if (value.startsWith('.') || value.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isZatString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
  try {
    await fs.chmod(dir, mode);
  } catch {
    // chmod is best-effort; the directory may be a mount with fixed mode.
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomHex(8)}`);
  const handle = await fs.open(tmp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  try {
    const dirHandle = await fs.open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is not available on every platform.
  }
}

export async function atomicWriteJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2), mode);
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function assertPathInside(parent: string, child: string): void {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path escapes its allowed directory');
  }
}
