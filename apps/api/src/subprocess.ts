import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURE = 256 * 1024;

function appendCaptured(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE * 2) return current;
  const next = current + chunk.toString('utf8');
  if (next.length <= MAX_CAPTURE * 2) return next;
  return next.slice(0, MAX_CAPTURE) + '\n...[truncated]...\n' + next.slice(-MAX_CAPTURE);
}

/** Run a fixed executable with an argument array. Never uses a shell. */
export function runFixed(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME ?? '/tmp',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        ...options.env,
      },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCaptured(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
