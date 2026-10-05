import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@bop/contracts';
import { runInContext } from '../../src/context';
import { createRedis } from '../../src/queues';
import { mailpitSearch } from '../../src/testing';
import { createHarness, publishWorkflow, spawnApp, waitFor, waitRun, type Harness, type Proc } from './helpers';

let h: Harness;
const procs: Proc[] = [];

function track(p: Proc): Proc {
  procs.push(p);
  return p;
}

async function killAll(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  await Promise.all(procs.splice(0).map((p) => p.kill(signal)));
}

function manual(
  name: string,
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'],
): WorkflowDefinition {
  return { name, trigger: { type: 'manual' }, nodes, edges };
}

async function start(wfId: string, tenantId = h.tenantId, ownerId = h.ownerId): Promise<string> {
  return runInContext(
    { tenantId, actor: { type: 'user', id: ownerId }, causation: [] },
    async () => (await h.core.runs.manualRun(wfId, {})).id,
  );
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

beforeAll(async () => {
  h = await createHarness('chaos', { STEP_CONCURRENCY: '16' });
});

afterAll(async () => {
  await killAll('SIGKILL');
  await h?.close();
});

describe('failure scenarios with real processes (WORKFLOW_ENGINE.md §6)', () => {
  it('mandatory #1: kill -9 of the worker during send_email → lease expires → another worker finishes → exactly one email', async () => {
    const to = `kill9-${h.res.id}@chaos.test`;
    const wf = await publishWorkflow(
      h,
      manual(
        'kill -9',
        [
          {
            id: 'remind',
            type: 'send_email',
            config: { to: `'${to}'`, subject: `Kill9 ${h.res.id}`, body: 'Exactly once please' },
          },
        ],
        [{ from: '$trigger', to: 'remind' }],
      ),
    );
    const a = track(
      spawnApp(
        'worker',
        {
          ...h.env,
          WORKER_ID: 'worker-a',
          MAIL_DISPATCH: '0',
          TEST_EFFECT_DELAY_MS: '20000',
          TEST_EFFECT_DELAY_NODE: 'remind',
        },
        'worker-a',
      ),
    );
    const runId = await start(wf);
    const step = await waitFor(async () => {
      const s = await h.core.deps.db.system.stepRun.findFirst({ where: { runId } });
      const effect =
        s === null
          ? null
          : await h.core.deps.db.system.effectLog.findFirst({
              where: { idempotencyKey: s.idempotencyKey, origin: 'engine' },
            });
      return s !== null && s.status === 'running' && s.leaseOwner?.startsWith('worker-a') === true && effect !== null
        ? s
        : null;
    }, 60_000);
    await a.kill('SIGKILL');
    expect(a.child.signalCode).toBe('SIGKILL');
    track(spawnApp('worker', { ...h.env, WORKER_ID: 'worker-b' }, 'worker-b'));
    track(spawnApp('scheduler', { ...h.env, SCHEDULER_ID: 'sched-1' }));
    expect(await waitRun(h, runId, ['succeeded', 'failed'], 60_000)).toBe('succeeded');
    const after = await h.core.deps.db.system.stepRun.findUnique({ where: { id: step.id } });
    expect(after?.attempt).toBe(2);
    expect((after?.attempts as Array<{ error: { code?: string } | null }>)[0]?.error?.code).toBe('lease_expired');
    expect(after?.leaseOwner).toBeNull();
    await waitFor(async () => (await mailpitSearch(h.res.mailpitUrl, `to:${to}`)).length >= 1, 30_000);
    await new Promise((r) => setTimeout(r, 3000));
    expect(await mailpitSearch(h.res.mailpitUrl, `to:${to}`)).toHaveLength(1);
    expect(await h.core.deps.db.system.emailMessage.count({ where: { idempotencyKey: step.idempotencyKey } })).toBe(1);
    await killAll();
  });

  it('mandatory #3: a wait_duration timer survives a full restart of api, worker and scheduler (lag < 10 s)', async () => {
    const seconds = Number(process.env['TIMER_TEST_SECONDS'] ?? 120);
    const wf = await publishWorkflow(
      h,
      manual(
        'restart timer',
        [
          { id: 'wait', type: 'wait_duration', config: { duration: `days(1) * (${seconds} / 86400)` } },
          { id: 'after', type: 'create_task', config: { title: `after restart ${h.res.id}` } },
        ],
        [
          { from: '$trigger', to: 'wait' },
          { from: 'wait', to: 'after' },
        ],
      ),
    );
    const env = { ...h.env, API_PORT: '4592' };
    const boot = () => {
      track(spawnApp('api', env));
      track(spawnApp('worker', { ...env, WORKER_ID: 'worker-r' }));
      track(spawnApp('scheduler', env));
    };
    boot();
    await waitFor(async () => (await fetch('http://127.0.0.1:4592/health').catch(() => null))?.ok === true, 30_000);
    const login = (await (
      await fetch('http://127.0.0.1:4592/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `owner-${h.res.id}@test.dev`, password: 'pw-123456' }),
      })
    ).json()) as { accessToken: string };
    const res = await fetch(`http://127.0.0.1:4592/v1/workflows/${wf}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const runId = ((await res.json()) as { id: string }).id;
    expect(await waitRun(h, runId, ['waiting'], 30_000)).toBe('waiting');
    await killAll('SIGTERM');
    await new Promise((r) => setTimeout(r, Math.min(20_000, (seconds * 1000) / 4)));
    boot();
    expect(await waitRun(h, runId, ['succeeded', 'failed'], (seconds + 60) * 1000)).toBe('succeeded');
    const wait = await h.core.deps.db.system.stepRun.findFirst({ where: { runId, nodeId: 'wait' } });
    const lagMs = (wait?.finishedAt?.getTime() ?? 0) - (wait?.scheduledFor?.getTime() ?? 0);
    process.stderr.write(`timer restart test: wait ${seconds}s, fired ${lagMs} ms after its scheduled time\n`);
    expect(lagMs).toBeGreaterThanOrEqual(0);
    expect(lagMs).toBeLessThan(10_000);
    await killAll();
  }, 600_000);

  it('mandatory #4: FLUSHDB of the Redis database while 100 runs are in flight → all runs complete (sweeper)', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'flush',
        [
          { id: 'first', type: 'condition', config: { expr: 'true' } },
          { id: 'pause', type: 'wait_duration', config: { duration: 'hours(1) / 1800' } },
          { id: 'task', type: 'create_task', config: { title: 'flush {{ run.id }}' } },
        ],
        [
          { from: '$trigger', to: 'first' },
          { from: 'first', to: 'pause', label: 'true' },
          { from: 'pause', to: 'task' },
        ],
      ),
    );
    track(spawnApp('worker', { ...h.env, WORKER_ID: 'worker-f1' }, 'worker-f1'));
    track(spawnApp('worker', { ...h.env, WORKER_ID: 'worker-f2' }, 'worker-f2'));
    track(spawnApp('scheduler', h.env));
    const runIds: string[] = [];
    for (let i = 0; i < 100; i += 10) runIds.push(...(await Promise.all(Array.from({ length: 10 }, () => start(wf)))));
    await new Promise((r) => setTimeout(r, 1200));
    const before = await h.core.deps.db.system.workflowRun.groupBy({
      by: ['status'],
      where: { workflowId: wf },
      _count: true,
    });
    const redis = createRedis(h.res.redisUrl);
    await redis.flushdb();
    redis.disconnect();
    process.stderr.write(`FLUSHDB issued with runs ${JSON.stringify(before.map((b) => [b.status, b._count]))}\n`);
    await waitFor(
      async () =>
        (await h.core.deps.db.system.workflowRun.count({ where: { workflowId: wf, status: 'succeeded' } })) === 100,
      120_000,
      500,
    );
    const tasks = await runInContext(h.ctx, () =>
      h.core.deps.db.scoped.task.count({ where: { title: { startsWith: 'flush ' } } }),
    );
    expect(tasks).toBe(100);
    await killAll();
  }, 300_000);

  it('mandatory #8: noisy neighbour — tenant A creates 5000 runs while tenant B runs 20; B step latency p95 stays within 2x of idle', async () => {
    const otherOwner = await h.core.accounts.createUser(`b-owner-${h.res.id}@test.dev`, 'B Owner', 'pw-123456');
    const tenantB = await h.core.accounts.createTenant({
      slug: `b-${h.res.id}`,
      name: 'Tenant B',
      ownerId: otherOwner,
    });
    const def = (name: string) =>
      manual(
        name,
        [
          { id: 'check', type: 'condition', config: { expr: 'true' } },
          { id: 'mark', type: 'create_task', config: { title: `${name} {{ run.id }}` } },
        ],
        [
          { from: '$trigger', to: 'check' },
          { from: 'check', to: 'mark', label: 'true' },
        ],
      );
    const wfA = await publishWorkflow(h, def('noisy-a'));
    const wfB = await runInContext(
      { tenantId: tenantB, actor: { type: 'user', id: otherOwner }, causation: [] },
      async () => {
        const wf = await h.core.workflows.create({ name: 'quiet-b', definition: def('quiet-b') });
        await h.core.workflows.publish(wf.id);
        return wf.id;
      },
    );
    track(spawnApp('worker', { ...h.env, WORKER_ID: 'worker-n1' }, 'worker-n1'));
    track(spawnApp('worker', { ...h.env, WORKER_ID: 'worker-n2' }, 'worker-n2'));
    track(spawnApp('scheduler', h.env));
    const apiUrl = 'http://127.0.0.1:4593';
    track(spawnApp('api', { ...h.env, API_PORT: '4593' }, 'api-noisy'));
    await waitFor(async () => (await fetch(`${apiUrl}/health`).catch(() => null))?.ok === true, 30_000);
    const tokenA = (
      (await (
        await fetch(`${apiUrl}/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: `owner-${h.res.id}@test.dev`, password: 'pw-123456' }),
        })
      ).json()) as { accessToken: string }
    ).accessToken;
    const parts = { queue: [] as number[], exec: [] as number[] };
    const latencies = async (runIds: string[], record = false) => {
      const rows = await h.core.deps.db.system.stepRun.findMany({ where: { runId: { in: runIds } } });
      const done = rows.filter((r) => r.finishedAt !== null && r.startedAt !== null);
      if (record) {
        parts.queue.push(...done.map((r) => (r.startedAt as Date).getTime() - r.createdAt.getTime()));
        parts.exec.push(...done.map((r) => (r.finishedAt as Date).getTime() - (r.startedAt as Date).getTime()));
      }
      return done.map((r) => (r.finishedAt as Date).getTime() - r.createdAt.getTime());
    };
    const runB = async (samples: number, gapMs = 100, until?: () => boolean) => {
      const ids: string[] = [];
      for (let i = 0; i < samples && (until === undefined || until()); i += 1) {
        ids.push(await start(wfB, tenantB, otherOwner));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      for (const id of ids) await waitRun(h, id, ['succeeded'], 120_000);
      return latencies(ids, until !== undefined);
    };
    const loadAvg = async () => (await import('node:os')).loadavg()[0]?.toFixed(1) ?? '?';
    await runB(10);
    const before = await runB(30, 150);
    const loadBefore = await loadAvg();
    const aIds: string[] = [];
    let refused = 0;
    let creating = true;
    let reserved = 0;
    const createA = async () => {
      while (reserved < 5000) {
        reserved += 1;
        for (;;) {
          const r = await fetch(`${apiUrl}/v1/workflows/${wfA}/runs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
            body: '{}',
          });
          const body = (await r.json()) as { id?: string; retryAfterMs?: number };
          if (r.status === 429) {
            refused += 1;
            const wait = Math.max(1, Number(body.retryAfterMs ?? 20));
            await new Promise((done) => setTimeout(done, wait + Math.random() * wait));
            continue;
          }
          if (r.status >= 300 || body.id === undefined) throw new Error(`run creation failed: ${r.status}`);
          aIds.push(body.id);
          break;
        }
      }
    };
    const createStart = Date.now();
    let createEnd = 0;
    const creators = Promise.all(Array.from({ length: 8 }, () => createA())).finally(() => {
      creating = false;
      createEnd = Date.now();
    });
    await new Promise((r) => setTimeout(r, 3000));
    const createdBefore = aIds.length;
    let maxBacklog = 0;
    const sampler = (async () => {
      while (creating) {
        maxBacklog = Math.max(
          maxBacklog,
          await h.core.deps.db.system.stepRun.count({ where: { tenantId: h.tenantId, status: 'pending' } }),
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    const noisy = await runB(400, 250, () => creating);
    const createdDuring = aIds.length - createdBefore;
    const loadDuring = await loadAvg();
    await creators;
    await sampler;
    await waitFor(
      async () =>
        (await h.core.deps.db.system.workflowRun.count({ where: { workflowId: wfA, status: 'running' } })) === 0,
      300_000,
      500,
    );
    const after = await runB(30, 150);
    const loadAfter = await loadAvg();
    const baseline = [...before, ...after];
    const p95Base = quantile(baseline, 0.95);
    const p95Noisy = quantile(noisy, 0.95);
    process.stderr.write(
      `noisy neighbour: A created ${aIds.length} runs in ${((createEnd - createStart) / 1000).toFixed(1)} s (${createdDuring} while B was measured, ${refused} attempts refused with 429), A pending steps max ${maxBacklog}; ` +
        `B step latency idle (before+after, ${baseline.length} steps) p50 ${quantile(baseline, 0.5)} ms p95 ${p95Base} ms [before p95 ${quantile(before, 0.95)}, after p95 ${quantile(after, 0.95)}]; ` +
        `under load (${noisy.length} steps) p50 ${quantile(noisy, 0.5)} ms p95 ${p95Noisy} ms (queue wait p95 ${quantile(parts.queue, 0.95)} ms, execution p95 ${quantile(parts.exec, 0.95)} ms); ratio ${(p95Noisy / Math.max(1, p95Base)).toFixed(2)}; ` +
        `load average before/during/after ${loadBefore}/${loadDuring}/${loadAfter}\n`,
    );
    expect(aIds).toHaveLength(5000);
    expect(createdDuring).toBeGreaterThan(1000);
    expect(noisy.length).toBeGreaterThan(100);
    const paced = (5000 - 500) / Math.max(1, (createEnd - createStart) / 1000);
    expect(paced).toBeLessThanOrEqual(55);
    expect(p95Noisy).toBeLessThanOrEqual(2 * p95Base);
    await killAll();
  }, 600_000);
});
