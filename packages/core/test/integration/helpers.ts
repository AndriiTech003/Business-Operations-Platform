import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { WorkflowDefinition } from '@bop/contracts';
import { Core } from '../../src/core';
import { loadConfig } from '../../src/config';
import { runInContext, type ExecContext } from '../../src/context';
import { createTestResources, testEnv, waitFor, type TestResources } from '../../src/testing';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface Harness {
  res: TestResources;
  core: Core;
  env: Record<string, string>;
  tenantId: string;
  ownerId: string;
  managerId: string;
  memberId: string;
  ctx: ExecContext;
  as<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const FAST_ENGINE: Record<string, string> = {
  SWEEP_INTERVAL_MS: '300',
  LOST_NUDGE_AFTER_MS: '2000',
  LEASE_MS: '3000',
  HEARTBEAT_MS: '1000',
  SCAN_INTERVAL_MS: '1000',
  OUTBOX_POLL_MS: '50',
  EMAIL_POLL_MS: '200',
  THROTTLE_RETRY_MS: '200',
  LEADER_TTL_MS: '3000',
  EMAIL_LEASE_MS: '5000',
};

export async function createHarness(
  label: string,
  extraEnv: Record<string, string> = {},
  opts: { databaseTimezone?: string } = {},
): Promise<Harness> {
  const res = await createTestResources(label);
  if (opts.databaseTimezone !== undefined) {
    const admin = new pg.Client({ connectionString: res.adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `ALTER DATABASE "bop_test_${res.id}" SET timezone TO '${opts.databaseTimezone.replace(/'/g, '')}'`,
      );
    } finally {
      await admin.end();
    }
  }
  const env = testEnv(res, {
    ...FAST_ENGINE,
    PUBLIC_API_URL: 'http://127.0.0.1:4590',
    PUBLIC_WEB_URL: 'http://127.0.0.1:4591',
    ...extraEnv,
  });
  const core = new Core({ service: `test-${label}`, config: loadConfig({ ...process.env, ...env, REALTIME_URL: '' }) });
  const ownerId = await core.accounts.createUser(`owner-${res.id}@test.dev`, 'Olga Owner', 'pw-123456');
  const tenantId = await core.accounts.createTenant({ slug: `t-${res.id}`, name: `Tenant ${res.id}`, ownerId });
  const ctx: ExecContext = { tenantId, actor: { type: 'user', id: ownerId }, causation: [] };
  const added = await runInContext(ctx, async () => ({
    manager: await core.accounts.addMember(`manager-${res.id}@test.dev`, 'Mona Manager', 'manager', 'pw-123456'),
    member: await core.accounts.addMember(`member-${res.id}@test.dev`, 'Milo Member', 'member', 'pw-123456'),
  }));
  return {
    res,
    core,
    env,
    tenantId,
    ownerId,
    managerId: added.manager.user.id,
    memberId: added.member.user.id,
    ctx,
    as: (fn) => runInContext(ctx, fn),
    async close() {
      await core.close().catch(() => undefined);
      await res.drop();
    },
  };
}

export async function publishWorkflow(h: Harness, definition: WorkflowDefinition): Promise<string> {
  return h.as(async () => {
    const wf = await h.core.workflows.create({ name: definition.name, definition });
    try {
      await h.core.workflows.publish(wf.id);
    } catch (error) {
      const details = (error as { details?: { errors?: unknown } }).details?.errors;
      throw new Error(`publish failed: ${(error as Error).message} ${JSON.stringify(details)}`, { cause: error });
    }
    return wf.id;
  });
}

export interface Proc {
  child: ChildProcess;
  name: string;
  output: () => string;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export function spawnApp(app: 'worker' | 'scheduler' | 'api', env: Record<string, string>, name: string = app): Proc {
  const child = spawn(process.execPath, ['--enable-source-maps', resolve(ROOT, `apps/${app}/dist/main.js`)], {
    env: { ...process.env, ...env, REALTIME_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  return {
    child,
    name,
    output: () => out,
    async kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill(signal);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

export async function runStatus(h: Harness, runId: string): Promise<string> {
  const run = await h.core.deps.db.system.workflowRun.findUnique({ where: { id: runId } });
  return run?.status ?? 'missing';
}

export async function waitRun(h: Harness, runId: string, statuses: string[], timeoutMs = 60_000): Promise<string> {
  return waitFor(
    async () => {
      const s = await runStatus(h, runId);
      return statuses.includes(s) ? s : null;
    },
    timeoutMs,
    100,
  );
}

export { waitFor };
