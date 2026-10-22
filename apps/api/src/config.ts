import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export interface ApiConfig {
  host: string;
  port: number;
  webDir: string;
  stateDir: string;
  workerSocket: string;
  publicOrigin: string | null;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  perIpSessionLimit: number;
  globalSessionLimit: number;
  requestBodyLimit: number;
}

export function loadApiConfig(): ApiConfig {
  const stateDir = required('AIRLOCK_API_STATE');
  return {
    host: optional('AIRLOCK_API_HOST', '127.0.0.1'),
    port: positiveInt('AIRLOCK_API_PORT', 8787),
    webDir: path.resolve(required('AIRLOCK_WEB_DIR')),
    stateDir: path.resolve(stateDir),
    workerSocket: path.resolve(required('AIRLOCK_WORKER_SOCKET')),
    publicOrigin: process.env.AIRLOCK_PUBLIC_ORIGIN?.trim() || null,
    cookieSecure: bool('AIRLOCK_COOKIE_SECURE', false),
    sessionTtlSeconds: positiveInt('AIRLOCK_SESSION_TTL_SECONDS', 86400 * 7),
    perIpSessionLimit: positiveInt('AIRLOCK_PER_IP_SESSION_LIMIT', 20),
    globalSessionLimit: positiveInt('AIRLOCK_GLOBAL_SESSION_LIMIT', 200),
    requestBodyLimit: positiveInt('AIRLOCK_REQUEST_BODY_LIMIT', 16 * 1024),
  };
}

export interface WorkerRuntimeConfig {
  socketPath: string;
  spoolDir: string;
  workerConfigPath: string;
  gateSocket: string;
  gateHome: string;
  walletDir: string;
  identityFile: string;
  recipientWalletDir: string;
  devtoolBin: string;
  syncIntervalSeconds: number;
  maxJobSeconds: number;
}

export function loadWorkerRuntimeConfig(): WorkerRuntimeConfig {
  return {
    socketPath: path.resolve(required('AIRLOCK_WORKER_SOCKET')),
    spoolDir: path.resolve(required('AIRLOCK_SPOOL_DIR')),
    workerConfigPath: path.resolve(required('AIRLOCK_WORKER_CONFIG')),
    gateSocket: path.resolve(required('AIRLOCK_GATE_SOCKET')),
    gateHome: path.resolve(required('AIRLOCK_GATE_HOME')),
    walletDir: path.resolve(required('AIRLOCK_WALLET_DIR')),
    identityFile: path.resolve(required('AIRLOCK_IDENTITY')),
    recipientWalletDir: path.resolve(required('AIRLOCK_RECIPIENT_WALLET')),
    devtoolBin: path.resolve(required('AIRLOCK_DEVTOOL_BIN')),
    syncIntervalSeconds: positiveInt('AIRLOCK_SYNC_INTERVAL_SECONDS', 300),
    maxJobSeconds: positiveInt('AIRLOCK_MAX_JOB_SECONDS', 240),
  };
}

export interface WorkerApprovalTerms {
  id: string;
  role: 'matching' | 'changed-recipient' | 'hidden-memo';
  recipientUa: string;
  amountZat: string;
  maxFeeZat: string;
  memo: { display: string; policy: 'exact' | 'empty' };
  expiresAt: string;
}

export interface WorkerSetConfig {
  approvals: Record<string, WorkerApprovalTerms>;
}

export interface TrustedWorkerConfig {
  version: 1;
  network: 'testnet';
  altRecipientUa: string;
  sets: Record<string, WorkerSetConfig>;
  limits: { maxAmountZat: string; maxFeeZat: string };
}

export function assertTestnetAddress(value: string): boolean {
  return value.startsWith('utest1') || value.startsWith('test1') || value.startsWith('tm');
}
