import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@bop/contracts';
import { runInContext, type ExecContext } from '../../src/context';
import { DomainError } from '../../src/errors';
import { WorkerRuntime } from '../../src/runtime/worker';
import { createHarness, publishWorkflow, waitRun, type Harness } from './helpers';

let h: Harness;
let runtime: WorkerRuntime;
let server: Server;
let slowUrl = '';
let inFlight = 0;
let maxInFlight = 0;

const quick: WorkflowDefinition = {
  name: 'quick',
  trigger: { type: 'manual' },
  nodes: [
    { id: 'check', type: 'condition', config: { expr: 'true' } },
    { id: 'done', type: 'end', config: {} },
  ],
  edges: [
    { from: '$trigger', to: 'check' },
    { from: 'check', to: 'done', label: 'true' },
  ],
};

function slow(name: string): WorkflowDefinition {
  return {
    name,
    trigger: { type: 'manual' },
    nodes: [{ id: 'call', type: 'http_request', config: { method: 'POST', url: slowUrl } }],
    edges: [{ from: '$trigger', to: 'call' }],
  };
}

async function tenantWith(slug: string, settings: Record<string, number>): Promise<ExecContext> {
  const owner = await h.core.accounts.createUser(`${slug}-${h.res.id}@test.dev`, slug, 'pw-123456');
  const tenantId = await h.core.accounts.createTenant({
    slug: `${slug}-${h.res.id}`,
    name: slug,
    ownerId: owner,
    settings,
  });
  return { tenantId, actor: { type: 'user', id: owner }, causation: [] };
}

async function publishIn(ctx: ExecContext, def: WorkflowDefinition): Promise<string> {
  return runInContext(ctx, async () => {
    const wf = await h.core.workflows.create({ name: def.name, definition: def });
    await h.core.workflows.publish(wf.id);
    return wf.id;
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    req.resume();
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, 120);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  slowUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/slow`;
  h = await createHarness('fair', { TENANT_RUN_RATE: '10', TENANT_RUN_BURST: '3', TENANT_RUN_MAX_WAIT_MS: '300' });
  runtime = new WorkerRuntime(h.core, { mail: false });
  await runtime.start();
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await runtime?.stop();
  await h?.res.drop();
});

describe('per-tenant run creation rate limit', () => {
  it('manual runs beyond the burst are paced up to the wait limit, then refused with 429 and a retry delay', async () => {
    const wf = await publishWorkflow(h, quick);
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h
          .as(() => h.core.runs.manualRun(wf, {}))
          .then(
            (r) => ({ ok: true as const, id: r.id, at: Date.now() - t0 }),
            (e: unknown) => ({ ok: false as const, error: e }),
          ),
      ),
    );
    const admitted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok).map((r) => r.error as DomainError);
    expect(admitted).toHaveLength(6);
    expect(Math.max(...admitted.map((r) => r.at))).toBeGreaterThanOrEqual(250);
    expect(refused).toHaveLength(4);
    for (const err of refused) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err.status).toBe(429);
      expect(err.code).toBe('run_rate_limited');
      expect(Number(err.details.extra?.['retryAfterMs'])).toBeGreaterThan(0);
    }
    const wait = Math.max(...refused.map((e) => Number(e.details.extra?.['retryAfterMs'])));
    await new Promise((r) => setTimeout(r, wait + 400));
    const later = await h.as(() => h.core.runs.manualRun(wf, {}));
    expect(await waitRun(h, later.id, ['succeeded'])).toBe('succeeded');
    for (const r of admitted) expect(await waitRun(h, r.id, ['succeeded'])).toBe('succeeded');
  });

  it('triggered runs are never dropped: beyond the burst their first steps are deferred', async () => {
    const ctx = await tenantWith('defer', { runsPerSecond: 10, runBurst: 2 });
    const wf = await publishIn(ctx, quick);
    const version = 1;
    const ids = await runInContext(ctx, async () => {
      const out: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const r = await h.core.engine.startRun({
          workflowId: wf,
          version,
          triggerType: 'manual',
          payload: { type: 'manual', firedAt: new Date().toISOString(), input: {} },
          admission: 'defer',
          dedupeKey: `defer-${i}`,
          causation: [],
        });
        out.push(r.runId);
      }
      return out;
    });
    const steps = await h.core.deps.db.system.stepRun.findMany({
      where: { runId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    const deferred = steps.filter((s) => s.scheduledFor !== null);
    expect(deferred.length).toBeGreaterThanOrEqual(3);
    const delays = deferred.map((s) => (s.scheduledFor as Date).getTime() - s.createdAt.getTime());
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(250);
    for (const id of ids) expect(await waitRun(h, id, ['succeeded', 'failed'], 30_000)).toBe('succeeded');
  });

  it('a tenant with runsPerSecond = 0 is not limited', async () => {
    const ctx = await tenantWith('unlimited', { runsPerSecond: 0 });
    const wf = await publishIn(ctx, quick);
    const ids = await runInContext(ctx, async () => {
      const out: string[] = [];
      for (let i = 0; i < 10; i += 1) out.push((await h.core.runs.manualRun(wf, {})).id);
      return out;
    });
    expect(ids).toHaveLength(10);
  });
});

describe('fair step scheduling: saturated tenants park steps instead of cycling them', () => {
  it('respects the tenant concurrency limit and parks each waiting step about once', async () => {
    const ctx = await tenantWith('parked', { maxConcurrentSteps: 1, runsPerSecond: 0 });
    const wf = await publishIn(ctx, slow('parked'));
    const before = (await h.core.deps.metrics.tenantThrottled.get()).values.find(
      (v) => v.labels['tenant'] === ctx.tenantId,
    );
    maxInFlight = 0;
    const ids = await runInContext(ctx, async () => {
      const out: string[] = [];
      for (let i = 0; i < 10; i += 1) out.push((await h.core.runs.manualRun(wf, {})).id);
      return out;
    });
    for (const id of ids) expect(await waitRun(h, id, ['succeeded', 'failed'], 60_000)).toBe('succeeded');
    expect(maxInFlight).toBe(1);
    const after = (await h.core.deps.metrics.tenantThrottled.get()).values.find(
      (v) => v.labels['tenant'] === ctx.tenantId,
    );
    const parks = (after?.value ?? 0) - (before?.value ?? 0);
    expect(parks).toBeGreaterThan(0);
    expect(parks).toBeLessThanOrEqual(20);
    expect(await h.core.engine.semaphore.parkedCount(ctx.tenantId)).toBe(0);
  });

  it('the scheduler sweep wakes parked steps when a holder vanished without releasing', async () => {
    const ctx = await tenantWith('ghost', { maxConcurrentSteps: 1, runsPerSecond: 0 });
    const wf = await publishIn(ctx, quick);
    expect(await h.core.engine.semaphore.acquire(ctx.tenantId, 'ghost-holder', 1)).toBe(true);
    const run = await runInContext(ctx, () => h.core.runs.manualRun(wf, {}));
    const deadline = Date.now() + 10_000;
    while ((await h.core.engine.semaphore.parkedCount(ctx.tenantId)) === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(await h.core.engine.semaphore.parkedCount(ctx.tenantId)).toBe(1);
    await new Promise((r) => setTimeout(r, Number(h.env['LEASE_MS']) + 300));
    expect(await h.core.engine.renudgeLost()).toBe(0);
    expect(await h.core.engine.unparkStalled()).toBe(1);
    expect(await waitRun(h, run.id, ['succeeded'], 20_000)).toBe('succeeded');
  });
});
