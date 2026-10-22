import net from 'node:net';

export interface WorkerError {
  ok: false;
  code: string;
  stage?: string;
  message?: string;
  retryable?: boolean;
  uncertain?: boolean;
}

export type WorkerResponse<T> = ({ ok: true } & T) | WorkerError;

export class WorkerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailable';
  }
}

export async function callWorker<T>(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 300_000,
): Promise<WorkerResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new WorkerUnavailable('worker response timeout')));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        finish(() => reject(new WorkerUnavailable('worker response too large')));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as WorkerResponse<T>);
        } catch {
          reject(new WorkerUnavailable('worker returned invalid JSON'));
        }
      });
    });
    socket.on('error', (error) => {
      finish(() => reject(new WorkerUnavailable(error.message)));
    });
    socket.on('close', () => {
      if (!settled && buffer.includes('\n')) return;
      finish(() => reject(new WorkerUnavailable('worker closed the connection')));
    });
    socket.on('end', () => {
      clearTimeout(timer);
    });
    socket.on('close', () => clearTimeout(timer));
  });
}
