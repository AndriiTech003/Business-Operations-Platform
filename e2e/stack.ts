import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = resolve(ROOT, '.e2e/state.json');
export const API = 'http://127.0.0.1:4560';
export const WEB = 'http://127.0.0.1:4561';
export const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

export interface StackState {
  id: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  pids: number[];
}

export function readState(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;
}

export function writeState(state: StackState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function stateExists(): boolean {
  return existsSync(STATE_FILE);
}

export function startProcess(args: string[], env: Record<string, string>, log: string, cwd = ROOT): number {
  mkdirSync(resolve(ROOT, '.e2e/logs'), { recursive: true });
  const out = resolve(ROOT, `.e2e/logs/${log}.log`);
  const child = spawn(args[0] as string, args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const chunks: Buffer[] = [];
  const flush = () => writeFileSync(out, Buffer.concat(chunks));
  child.stdout?.on('data', (d: Buffer) => {
    chunks.push(d);
    flush();
  });
  child.stderr?.on('data', (d: Buffer) => {
    chunks.push(d);
    flush();
  });
  child.unref();
  return child.pid as number;
}

export function run(cmd: string, args: string[], env: Record<string, string>, cwd = ROOT): void {
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
}

export async function waitHttp(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      await new Promise((res) => setTimeout(res, 300));
      continue;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`${url} did not become ready`);
}
