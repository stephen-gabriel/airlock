import { promises as fs } from 'node:fs';
import net from 'node:net';
import { runFixed, type CommandResult } from './subprocess.js';
import { sha256Hex } from './util.js';

export interface GatePaths {
  devtoolBin: string;
  gateHome: string;
  gateSocket: string;
  walletDir: string;
  identityFile: string;
  recipientWalletDir: string;
}

export interface GateErrorInfo {
  ok: false;
  code: string;
  stage: string;
  detail: string;
}

export interface ValidateResult {
  ok: true;
  feeZat: string | null;
  output: string;
}

export interface SignResult {
  ok: true;
  txid: string;
  recovered: boolean;
  feeZat: string | null;
  output: string;
}

export interface ApprovalLine {
  id: string;
  status: string;
  boundTxid: string | null;
  artifact: string | null;
  expiresAt: string | null;
}

const CODE_RE = /\b(E_[A-Z0-9_]+)\b/;
const STAGE_RE = /\[([a-z_]+)\]/;

export function findGateCode(text: string): string | null {
  const match = text.match(CODE_RE);
  return match?.[1] ?? null;
}

export function findGateStage(text: string): string {
  return text.match(STAGE_RE)?.[1] ?? 'gate';
}

function failure(result: CommandResult, fallback: string): GateErrorInfo {
  const combined = `${result.stdout}\n${result.stderr}`;
  const code = findGateCode(combined) ?? fallback;
  return {
    ok: false,
    code,
    stage: findGateStage(combined),
    detail: combined.trim(),
  };
}

export async function syncWallet(walletDir: string, devtoolBin: string, timeoutMs = 120_000): Promise<{
  ok: true;
  tip: number;
  balanceJson: Record<string, unknown> | null;
} | GateErrorInfo> {
  const sync = await runFixed(devtoolBin, ['wallet', '-w', walletDir, 'sync'], { timeoutMs });
  if (sync.code !== 0) {
    return {
      ok: false,
      code: sync.timedOut ? 'E_SYNC_FAILED' : 'E_SYNC_FAILED',
      stage: 'sync',
      detail: `${sync.stdout}\n${sync.stderr}`.trim(),
    };
  }
  const balance = await runFixed(devtoolBin, ['wallet', '-w', walletDir, 'balance', '--json'], {
    timeoutMs: 30_000,
  });
  if (balance.code !== 0) {
    return {
      ok: false,
      code: 'E_TIP_UNAVAILABLE',
      stage: 'sync',
      detail: `${balance.stdout}\n${balance.stderr}`.trim(),
    };
  }
  const line = balance.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => value.startsWith('{'));
  if (!line) {
    return { ok: false, code: 'E_TIP_UNAVAILABLE', stage: 'sync', detail: 'no balance JSON' };
  }
  try {
    const parsed = JSON.parse(line) as { chain_tip_height?: number };
    const tip = Number(parsed.chain_tip_height);
    if (!Number.isInteger(tip) || tip <= 0) {
      return { ok: false, code: 'E_TIP_UNAVAILABLE', stage: 'sync', detail: 'no chain tip' };
    }
    return { ok: true, tip, balanceJson: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'E_TIP_UNAVAILABLE', stage: 'sync', detail: 'bad balance JSON' };
  }
}

export async function createProposal(
  paths: GatePaths,
  options: {
    recipientUa: string;
    amountZat: string;
    memoText: string;
    memoHex: string | null;
    createdPath: string;
  },
): Promise<{ ok: true; txid: string | null; output: string } | GateErrorInfo> {
  const createArgs = [
    'pczt',
    '-w',
    paths.walletDir,
    'create',
    '--address',
    options.recipientUa,
    '--value',
    options.amountZat,
    '--output',
    options.createdPath,
  ];
  if (options.memoHex !== null) {
    createArgs.push('--memo-hex', options.memoHex);
  } else {
    createArgs.push('--memo', options.memoText);
  }
  const create = await runFixed(paths.devtoolBin, createArgs, { timeoutMs: 180_000 });
  if (create.code !== 0) {
    const failed = failure(create, 'E_BUILD_FAILED');
    return { ...failed, code: failed.code === 'E_INTERNAL' ? 'E_BUILD_FAILED' : failed.code };
  }
  const txid = await inspectTxid(paths, options.createdPath);
  return { ok: true, txid, output: create.stdout };
}

export async function proveProposal(
  paths: GatePaths,
  createdPath: string,
  provenPath: string,
): Promise<{ ok: true; output: string } | GateErrorInfo> {
  const prove = await runFixed(
    paths.devtoolBin,
    [
      'pczt',
      '-w',
      paths.walletDir,
      'prove',
      '-i',
      paths.identityFile,
      createdPath,
      '--output',
      provenPath,
    ],
    { timeoutMs: 300_000 },
  );
  if (prove.code !== 0) {
    const failed = failure(prove, 'E_PROVE_FAILED');
    return { ...failed, code: failed.code === 'E_INTERNAL' ? 'E_PROVE_FAILED' : failed.code };
  }
  return { ok: true, output: prove.stdout };
}

export async function inspectTxid(paths: GatePaths, proposalPath: string): Promise<string | null> {
  const inspect = await runFixed(paths.devtoolBin, ['pczt', 'inspect', proposalPath], {
    timeoutMs: 30_000,
  });
  if (inspect.code !== 0) return null;
  const match = inspect.stdout.match(/TxID:\s*([0-9a-f]{64})/);
  return match?.[1] ?? null;
}

export async function gateValidate(
  paths: GatePaths,
  approvalId: string,
  proposalPath: string,
): Promise<ValidateResult | GateErrorInfo> {
  const result = await runFixed(
    paths.devtoolBin,
    [
      'airlock-gate',
      'validate',
      '--gate-home',
      paths.gateHome,
      '--wallet',
      paths.walletDir,
      '--identity',
      paths.identityFile,
      '--proposal',
      proposalPath,
      '--approval-id',
      approvalId,
    ],
    { timeoutMs: 90_000 },
  );
  if (result.code === 0 && result.stdout.includes('VALIDATE_OK')) {
    const fee = result.stdout.match(/fee_zat=(\d+)/);
    return { ok: true, feeZat: fee?.[1] ?? null, output: result.stdout };
  }
  return failure(result, 'E_INTERNAL');
}

export async function gateSubmit(
  paths: GatePaths,
  approvalId: string,
  proposalPath: string,
  outputPath: string,
): Promise<SignResult | GateErrorInfo> {
  const result = await runFixed(
    paths.devtoolBin,
    [
      'airlock-gate',
      'submit',
      '--socket',
      paths.gateSocket,
      '--approval-id',
      approvalId,
      '--proposal',
      proposalPath,
      '--output',
      outputPath,
    ],
    { timeoutMs: 150_000 },
  );
  const txid = result.stdout.match(/txid=([0-9a-f]{64})/)?.[1];
  if (result.code === 0 && txid) {
    return {
      ok: true,
      txid,
      recovered: /SIGN_RECOVERED_OK/.test(result.stdout),
      feeZat: result.stdout.match(/fee_zat=(\d+)/)?.[1] ?? null,
      output: result.stdout,
    };
  }
  return failure(result, 'E_INTERNAL');
}

export async function gateApprovalLines(paths: GatePaths): Promise<ApprovalLine[] | null> {
  const result = await runFixed(
    paths.devtoolBin,
    ['airlock-gate', 'approvals', '--gate-home', paths.gateHome, 'list'],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) return null;
  const lines: ApprovalLine[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(
      /^(\S+) status=(\w+) amount=\d+ max_fee=\d+ bound=(?:None|Some\(([0-9a-f]{64})\)) artifact=(?:None|Some\(([^)]+)\)) expires_at=(\d+)/,
    );
    if (!match) continue;
    lines.push({
      id: match[1] ?? '',
      status: match[2] ?? 'unknown',
      boundTxid: match[3] ?? null,
      artifact: match[4] ?? null,
      expiresAt: match[5] ? new Date(Number(match[5]) * 1000).toISOString() : null,
    });
  }
  return lines;
}

export async function broadcastArtifact(
  paths: GatePaths,
  artifactPath: string,
): Promise<
  | { ok: true; txid: string; output: string }
  | { ok: false; code: string; uncertain: boolean; detail: string }
> {
  const result = await runFixed(
    paths.devtoolBin,
    ['pczt', '-w', paths.walletDir, 'send-without-storing', artifactPath],
    { timeoutMs: 150_000 },
  );
  const txid = result.stdout.match(/\b([0-9a-f]{64})\b/)?.[1];
  if (result.code === 0 && txid) {
    return { ok: true, txid, output: result.stdout };
  }
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: false,
    code: 'E_BROADCAST_UNKNOWN',
    uncertain: true,
    detail: combined,
  };
}

export async function walletTxStatus(
  paths: GatePaths,
  txid: string,
): Promise<
  | { ok: true; found: boolean; minedHeight: number | null; syncedAt: string }
  | GateErrorInfo
> {
  const sync = await runFixed(
    paths.devtoolBin,
    ['wallet', '-w', paths.recipientWalletDir, 'sync'],
    { timeoutMs: 150_000 },
  );
  if (sync.code !== 0) {
    return {
      ok: false,
      code: 'E_STATUS_UNAVAILABLE',
      stage: 'status',
      detail: `${sync.stdout}\n${sync.stderr}`.trim(),
    };
  }
  const list = await runFixed(
    paths.devtoolBin,
    ['wallet', '-w', paths.recipientWalletDir, 'list-tx', '--json'],
    { timeoutMs: 60_000 },
  );
  if (list.code !== 0) {
    return {
      ok: false,
      code: 'E_STATUS_UNAVAILABLE',
      stage: 'status',
      detail: `${list.stdout}\n${list.stderr}`.trim(),
    };
  }
  const line = list.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .reverse()
    .find((value) => value.startsWith('['));
  if (!line) {
    return { ok: false, code: 'E_STATUS_UNAVAILABLE', stage: 'status', detail: 'no list JSON' };
  }
  try {
    const rows = JSON.parse(line) as { txid: string; mined_height: number | null }[];
    const row = rows.find((value) => value.txid === txid);
    return {
      ok: true,
      found: Boolean(row),
      minedHeight: row?.mined_height ?? null,
      syncedAt: new Date().toISOString(),
    };
  } catch {
    return { ok: false, code: 'E_STATUS_UNAVAILABLE', stage: 'status', detail: 'bad list JSON' };
  }
}

export async function hashFile(file: string): Promise<string | null> {
  try {
    const value = await fs.readFile(file);
    return sha256Hex(value);
  } catch {
    return null;
  }
}

export async function checkGateSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 750);
    socket.on('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}
