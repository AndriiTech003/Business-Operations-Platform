import { createServer, type Server } from 'node:http';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@bop/contracts';
import { QUEUE_NAMES, createRedis } from '../../src/queues';
import { WorkerRuntime } from '../../src/runtime/worker';
import { LeaderLock } from '../../src/engine/primitives';
import { createHarness, publishWorkflow, waitFor, waitRun, type Harness } from './helpers';

let h: Harness;
let runtime: WorkerRuntime;
let http: Server;
let httpUrl = '';
const hits = new Map<string, number>();
const callbacks: Array<{ headers: Record<string, unknown>; body: unknown }> = [];

function manual(
  name: string,
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'],
  inputs: Array<{ key: string; label: string; type: 'string' | 'number' | 'bool' | 'date'; required: boolean }> = [],
): WorkflowDefinition {
  return { name, trigger: { type: 'manual', inputs }, nodes, edges };
}

async function start(wfId: string, input: Record<string, unknown> = {}): Promise<string> {
  const run = await h.as(() => h.core.runs.manualRun(wfId, { input }));
  return run.id;
}

async function steps(runId: string) {
  return h.core.deps.db.system.stepRun.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
}

beforeAll(async () => {
  h = await createHarness('engine');
  http = createServer((req, res) => {
    const key = req.url ?? '/';
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      if (key.startsWith('/flaky')) {
        res.writeHead(n <= 2 ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ attempt: n, idempotencyKey: req.headers['idempotency-key'] }));
      } else if (key.startsWith('/bad')) {
        res.writeHead(400);
        res.end('nope');
      } else if (key.startsWith('/slow')) {
        setTimeout(() => {
          if (!res.writableEnded) res.end('late');
        }, 30_000);
      } else if (key.startsWith('/callback')) {
        callbacks.push({ headers: req.headers, body: JSON.parse(body) as unknown });
        res.end('ok');
      } else {
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  httpUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  runtime = new WorkerRuntime(h.core, { mail: false });
  await runtime.start();
});

afterAll(async () => {
  http?.closeAllConnections();
  http?.close();
  await runtime?.stop();
  await h?.res.drop();
});

describe('workflow engine (in-process, real Postgres + Redis + BullMQ)', () => {
  it('runs a manual workflow end to end and creates the task once', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'simple',
        [
          { id: 'big', type: 'condition', config: { expr: 'input.amount > 100' } },
          { id: 'task', type: 'create_task', config: { title: 'Big one: {{ input.amount }}', priority: 1 } },
          { id: 'end', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'big' },
          { from: 'big', to: 'task', label: 'true' },
          { from: 'big', to: 'end', label: 'false' },
        ],
        [{ key: 'amount', label: 'Amount', type: 'number', required: true }],
      ),
    );
    const runId = await start(wf, { amount: 500 });
    expect(await waitRun(h, runId, ['succeeded', 'failed'])).toBe('succeeded');
    const s = await steps(runId);
    expect(s.find((x) => x.nodeId === 'end')?.status).toBe('skipped');
    expect(s.find((x) => x.nodeId === 'task')?.status).toBe('succeeded');
    const tasks = await h.as(() => h.core.deps.db.scoped.task.findMany({ where: { title: 'Big one: 500' } }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.createdByType).toBe('workflow');
  });

  it('mandatory #2: ten identical BullMQ nudges execute the step handler once', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'dup nudges',
        [{ id: 'task', type: 'create_task', config: { title: 'dup-nudge-task' } }],
        [{ from: '$trigger', to: 'task' }],
      ),
    );
    await h.core.deps.queues.steps.pause();
    const events = new QueueEvents(QUEUE_NAMES.steps, {
      connection: createRedis(h.core.config.redisUrl, true),
      prefix: `${h.core.config.redisPrefix}:bull`,
    });
    await events.waitUntilReady();
    const results: string[] = [];
    events.on('completed', ({ returnvalue }) => results.push(String(returnvalue)));
    try {
      const runId = await start(wf);
      const step = (await steps(runId))[0];
      expect(step).toBeDefined();
      const jobs = Array.from({ length: 10 }, () => ({ stepRunId: step!.id, tenantId: h.tenantId }));
      await h.core.deps.queues.nudgeSteps(jobs);
      await h.core.deps.queues.steps.resume();
      expect(await waitRun(h, runId, ['succeeded', 'failed'])).toBe('succeeded');
      await waitFor(async () => results.length >= 11, 20_000);
      const after = await h.core.deps.db.system.stepRun.findUnique({ where: { id: step!.id } });
      expect(after?.attempt).toBe(1);
      expect(results.filter((r) => r === 'not-claimed')).toHaveLength(10);
      expect(results.filter((r) => r === 'next')).toHaveLength(1);
      const tasks = await h.as(() => h.core.deps.db.scoped.task.count({ where: { title: 'dup-nudge-task' } }));
      expect(tasks).toBe(1);
    } finally {
      await h.core.deps.queues.steps.resume();
      await events.close();
    }
  });

  it('mandatory #5: two branches finishing at the same time create the join step exactly once', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'join race',
        [
          { id: 'go', type: 'condition', config: { expr: 'true' } },
          { id: 'a', type: 'notify', config: { to: 'user(input.owner)', message: 'a' } },
          { id: 'b', type: 'notify', config: { to: 'user(input.owner)', message: 'b' } },
          { id: 'join', type: 'create_task', config: { title: 'joined {{ run.id }}' } },
        ],
        [
          { from: '$trigger', to: 'go' },
          { from: 'go', to: 'a', label: 'true' },
          { from: 'go', to: 'b', label: 'true' },
          { from: 'a', to: 'join' },
          { from: 'b', to: 'join' },
        ],
        [{ key: 'owner', label: 'Owner', type: 'string', required: true }],
      ),
    );
    await h.core.deps.queues.steps.pause();
    try {
      const runIds: string[] = [];
      for (let i = 0; i < 15; i += 1) {
        const runId = await start(wf, { owner: h.managerId });
        runIds.push(runId);
        const go = (await steps(runId)).find((s) => s.nodeId === 'go');
        await h.core.engine.processStep(go!.id, h.tenantId);
        const branches = (await steps(runId)).filter((s) => s.nodeId === 'a' || s.nodeId === 'b');
        expect(branches).toHaveLength(2);
        await Promise.all(branches.map((s) => h.core.engine.processStep(s.id, h.tenantId)));
        const joins = (await steps(runId)).filter((s) => s.nodeId === 'join');
        expect(joins).toHaveLength(1);
      }
      await h.core.deps.queues.steps.resume();
      for (const runId of runIds) expect(await waitRun(h, runId, ['succeeded', 'failed'])).toBe('succeeded');
      const joined = await h.as(() =>
        h.core.deps.db.scoped.task.count({ where: { title: { startsWith: 'joined ' } } }),
      );
      expect(joined).toBe(15);
    } finally {
      await h.core.deps.queues.steps.resume();
    }
  });

  it('mandatory #6: a waiting run finishes on its own version after v2 is published', async () => {
    const def = manual(
      'versions',
      [
        { id: 'ask', type: 'approval', config: { assignees: "role('manager')", title: 'Version check' } },
        { id: 'after', type: 'create_task', config: { title: 'from v1' } },
      ],
      [
        { from: '$trigger', to: 'ask' },
        { from: 'ask', to: 'after', label: 'approved' },
      ],
    );
    const wf = await publishWorkflow(h, def);
    const runId = await start(wf);
    expect(await waitRun(h, runId, ['waiting'])).toBe('waiting');
    await h.as(async () => {
      await h.core.workflows.saveDraft(wf, {
        ...def,
        nodes: def.nodes.map((n) => (n.id === 'after' ? { ...n, config: { title: 'from v2' } } : n)),
      });
      await h.core.workflows.publish(wf);
    });
    const detail = await h.as(() => h.core.workflows.get(wf));
    expect(detail.activeVersion).toBe(2);
    const approval = await h.as(async () =>
      (await h.core.approvals.list('pending', undefined)).find((a) => a.title === 'Version check'),
    );
    await h.as(() => h.core.approvals.decide(approval!.id, { decision: 'approve' }, h.managerId, 'manager'));
    expect(await waitRun(h, runId, ['succeeded', 'failed'])).toBe('succeeded');
    const run = await h.core.deps.db.system.workflowRun.findUnique({ where: { id: runId } });
    expect(run?.version).toBe(1);
    const out = (await steps(runId)).find((s) => s.nodeId === 'after')?.output as { title?: string };
    expect(out.title).toBe('from v1');
  });

  it('mandatory #7: "on deal update → update deal" does not loop; two workflows that trigger each other stop', async () => {
    const deal = await h.as(() => h.core.deals.create({ title: 'Loop', amountCents: 1000, currency: 'USD' }));
    const w1 = await publishWorkflow(h, {
      name: 'self loop',
      trigger: { type: 'record_event', entity: 'deal', event: 'deal.updated', filter: "deal.id == '" + deal.id + "'" },
      nodes: [{ id: 'bump', type: 'update_record', config: { record: 'deal', fields: { title: "deal.title + '!'" } } }],
      edges: [{ from: '$trigger', to: 'bump' }],
    });
    await h.as(() => h.core.deals.update(deal.id, { amountCents: 2000 }));
    await waitFor(
      async () =>
        (await h.core.deps.db.system.workflowRun.count({ where: { workflowId: w1, status: 'succeeded' } })) >= 1,
      30_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    expect(await h.core.deps.db.system.workflowRun.count({ where: { workflowId: w1 } })).toBe(1);
    expect((await h.as(() => h.core.deals.get(deal.id))).title).toBe('Loop!');

    const other = await h.as(() => h.core.deals.create({ title: 'Pong', amountCents: 1000, currency: 'USD' }));
    const filter = "deal.id == '" + other.id + "'";
    const a = await publishWorkflow(h, {
      name: 'ping',
      trigger: { type: 'record_event', entity: 'deal', event: 'deal.updated', filter },
      nodes: [{ id: 'a', type: 'update_record', config: { record: 'deal', fields: { title: "deal.title + 'a'" } } }],
      edges: [{ from: '$trigger', to: 'a' }],
    });
    const b = await publishWorkflow(h, {
      name: 'pong',
      trigger: { type: 'record_event', entity: 'deal', event: 'deal.updated', filter },
      nodes: [
        {
          id: 'b',
          type: 'update_record',
          config: { record: 'deal', fields: { lostReason: "'touched by pong ' + deal.title" } },
        },
      ],
      edges: [{ from: '$trigger', to: 'b' }],
    });
    await h.as(() => h.core.deals.update(other.id, { amountCents: 3000 }));
    await waitFor(
      async () =>
        (await h.core.deps.db.system.workflowRun.count({
          where: { workflowId: { in: [a, b] }, status: 'succeeded' },
        })) >= 4,
      30_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    const runs = await h.core.deps.db.system.workflowRun.findMany({ where: { workflowId: { in: [a, b] } } });
    expect(runs.filter((r) => r.workflowId === a)).toHaveLength(2);
    expect(runs.filter((r) => r.workflowId === b)).toHaveLength(2);
    const chains = runs.map((r) => (r.causation as Array<{ workflowId: string }>).map((c) => c.workflowId));
    expect(chains.every((c) => new Set(c).size === c.length && c.length <= 1)).toBe(true);
  });

  it('retries retryable errors with backoff and keeps the same Idempotency-Key', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'flaky http',
        [
          {
            id: 'call',
            type: 'http_request',
            config: { method: 'POST', url: `${httpUrl}/flaky-1`, body: '{"a":1}' },
            retry: { maxAttempts: 5, backoff: 'exponential', initialMs: 100 },
          },
        ],
        [{ from: '$trigger', to: 'call' }],
      ),
    );
    const runId = await start(wf);
    expect(await waitRun(h, runId, ['succeeded', 'failed'], 30_000)).toBe('succeeded');
    const step = (await steps(runId))[0];
    expect(step?.attempt).toBe(3);
    expect((step?.output as { body: { idempotencyKey: string } }).body.idempotencyKey).toBe(step?.idempotencyKey);
    expect(step?.idempotencyKey).toBe(`${runId}:call:0`);
    expect((step?.attempts as Array<{ error: unknown }>).filter((a) => a.error !== null)).toHaveLength(2);
  });

  it('classifies 4xx as permanent: fails the run, or follows the error edge when present', async () => {
    const failing = await publishWorkflow(
      h,
      manual(
        'bad http',
        [{ id: 'call', type: 'http_request', config: { method: 'GET', url: `${httpUrl}/bad-1` } }],
        [{ from: '$trigger', to: 'call' }],
      ),
    );
    const r1 = await start(failing);
    expect(await waitRun(h, r1, ['succeeded', 'failed'])).toBe('failed');
    expect((await steps(r1))[0]?.attempt).toBe(1);
    const handled = await publishWorkflow(
      h,
      manual(
        'bad http handled',
        [
          { id: 'call', type: 'http_request', config: { method: 'GET', url: `${httpUrl}/bad-2` } },
          { id: 'fallback', type: 'create_task', config: { title: 'call failed: {{ steps.call.output.error }}' } },
        ],
        [
          { from: '$trigger', to: 'call' },
          { from: 'call', to: 'fallback', label: 'error' },
        ],
      ),
    );
    const r2 = await start(handled);
    expect(await waitRun(h, r2, ['succeeded', 'failed'])).toBe('succeeded');
    const s = await steps(r2);
    expect(s.find((x) => x.nodeId === 'call')?.status).toBe('failed');
    expect(s.find((x) => x.nodeId === 'fallback')?.status).toBe('succeeded');
  });

  it('retry of a failed step from the UI continues the same run', async () => {
    const failing = await publishWorkflow(
      h,
      manual(
        'retry me',
        [
          {
            id: 'call',
            type: 'http_request',
            config: { method: 'GET', url: `${httpUrl}/flaky-retry` },
            retry: { maxAttempts: 1 },
          },
        ],
        [{ from: '$trigger', to: 'call' }],
      ),
    );
    const runId = await start(failing);
    expect(await waitRun(h, runId, ['failed'])).toBe('failed');
    const step = (await steps(runId))[0]!;
    await h.as(() => h.core.engine.retryStep(runId, step.id));
    await waitFor(
      async () =>
        (await h.core.deps.db.system.stepRun.findUnique({ where: { id: step.id } }))?.status === 'failed' &&
        (await h.core.deps.db.system.stepRun.findUnique({ where: { id: step.id } }))!.attempt >= 2,
      20_000,
    );
    await h.as(() => h.core.engine.retryStep(runId, step.id));
    expect(await waitRun(h, runId, ['succeeded'], 20_000)).toBe('succeeded');
    expect((await h.core.deps.db.system.stepRun.findUnique({ where: { id: step.id } }))?.attempt).toBe(3);
  });

  it('cancellation aborts a running step through Redis pub/sub', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'slow',
        [{ id: 'call', type: 'http_request', config: { method: 'GET', url: `${httpUrl}/slow-1` }, timeoutMs: 60_000 }],
        [{ from: '$trigger', to: 'call' }],
      ),
    );
    const runId = await start(wf);
    await waitFor(async () => (await steps(runId))[0]?.status === 'running', 20_000);
    const t0 = Date.now();
    await h.as(() => h.core.engine.cancelRun(runId));
    expect(await runStatusOf(runId)).toBe('cancelled');
    await waitFor(async () => (await steps(runId))[0]?.status === 'cancelled', 10_000);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('for_each runs the body per item with bounded concurrency and collects results', async () => {
    const wf = await publishWorkflow(
      h,
      manual(
        'loop',
        [
          { id: 'each', type: 'for_each', config: { items: '[1, 2, 3, 4, 5]', concurrency: 2 } },
          { id: 'mk', type: 'create_task', config: { title: 'item {{ item }} of loop {{ run.id }}' } },
          { id: 'end', type: 'end', config: {} },
        ],
        [
          { from: '$trigger', to: 'each' },
          { from: 'each', to: 'mk', label: 'item' },
          { from: 'each', to: 'end', label: 'done' },
        ],
      ),
    );
    const runId = await start(wf);
    expect(await waitRun(h, runId, ['succeeded', 'failed'], 30_000)).toBe('succeeded');
    const s = await steps(runId);
    expect(s.filter((x) => x.nodeId === 'mk')).toHaveLength(5);
    const loop = s.find((x) => x.nodeId === 'each');
    expect((loop?.output as { count: number; results: unknown[] }).count).toBe(5);
    expect((loop?.output as { results: unknown[] }).results).toHaveLength(5);
    expect(s.find((x) => x.nodeId === 'end')?.status).toBe('succeeded');
  });

  it('test runs use the draft definition and only dry-run effects', async () => {
    const company = await h.as(() => h.core.companies.create({ name: 'Dry Run Co' }));
    const def: WorkflowDefinition = {
      name: 'dry',
      trigger: { type: 'manual', entity: 'company' },
      nodes: [
        {
          id: 'mail',
          type: 'send_email',
          config: { to: "'dry@example.test'", subject: 'Hello {{ company.name }}', body: 'Body' },
        },
        { id: 'upd', type: 'update_record', config: { record: 'company', fields: { name: "'Renamed'" } } },
        { id: 'call', type: 'http_request', config: { method: 'POST', url: `${httpUrl}/never` } },
        { id: 'ok', type: 'approval', config: { assignees: "role('manager')", title: 'test' } },
      ],
      edges: [
        { from: '$trigger', to: 'mail' },
        { from: 'mail', to: 'upd' },
        { from: 'upd', to: 'call' },
        { from: 'call', to: 'ok' },
      ],
    };
    const wf = await h.as(() => h.core.workflows.create({ name: 'dry', definition: def }));
    const run = await h.as(() => h.core.runs.testRun(wf.id, { recordId: company.id, approvals: 'approve' }));
    expect(await waitRun(h, run.id, ['succeeded', 'failed'])).toBe('succeeded');
    const s = await steps(run.id);
    expect(
      (s.find((x) => x.nodeId === 'mail')?.output as { dryRun: boolean; preview: { subject: string } }).preview.subject,
    ).toBe('Hello Dry Run Co');
    expect((s.find((x) => x.nodeId === 'upd')?.output as { dryRun: boolean }).dryRun).toBe(true);
    expect(s.find((x) => x.nodeId === 'ok')?.outcome).toBe('approved');
    expect(hits.get('/never') ?? 0).toBe(0);
    expect(await h.as(() => h.core.deps.db.scoped.emailMessage.count({ where: { subject: 'Hello Dry Run Co' } }))).toBe(
      0,
    );
    expect((await h.as(() => h.core.companies.get(company.id))).name).toBe('Dry Run Co');
  });

  it('webhook triggers validate the body with JSON Schema', async () => {
    const wf = await publishWorkflow(h, {
      name: 'hook',
      trigger: {
        type: 'webhook',
        schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
      },
      nodes: [{ id: 't', type: 'create_task', config: { title: 'Lead {{ payload.email }}' } }],
      edges: [{ from: '$trigger', to: 't' }],
    });
    const row = await h.as(() => h.core.workflows.row(wf));
    await expect(h.core.runs.webhook(wf, row.webhookSecret, { email: 'not-an-email' })).rejects.toThrow(
      /does not match/,
    );
    await expect(h.core.runs.webhook(wf, 'wrong', { email: 'a@b.co' })).rejects.toThrow(/Unknown webhook/);
    const { runId } = await h.core.runs.webhook(wf, row.webhookSecret, { email: 'lead@hook.test' });
    expect(await waitRun(h, runId, ['succeeded', 'failed'])).toBe('succeeded');
  });

  it('schedule triggers fire once per cron tick and compute the next fire time in the tenant time zone', async () => {
    const wf = await publishWorkflow(h, {
      name: 'cron',
      trigger: { type: 'schedule', cron: '*/5 * * * *', timezone: 'Europe/Berlin' },
      nodes: [{ id: 'e', type: 'end', config: {} }],
      edges: [{ from: '$trigger', to: 'e' }],
    });
    await h.core.deps.db.system.workflow.update({
      where: { id: wf },
      data: { nextFireAt: new Date(Date.now() - 1000) },
    });
    const fired = await h.core.runs.fireSchedules(new Date());
    expect(fired).toBeGreaterThanOrEqual(1);
    const again = await h.core.runs.fireSchedules(new Date());
    expect(again).toBe(0);
    const row = await h.core.deps.db.system.workflow.findUnique({ where: { id: wf } });
    expect(row!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row!.nextFireAt!.getUTCMinutes() % 5).toBe(0);
  });

  it('record_condition scanner starts one run per matching record (dedupe)', async () => {
    const company = await h.as(() => h.core.companies.create({ name: 'Scan Co' }));
    const inv = await h.as(() =>
      h.core.invoices.create({
        companyId: company.id,
        currency: 'USD',
        issueDate: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        dueDate: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        lines: [{ description: 'x', quantity: 1, unitPriceCents: 250000, taxRate: 0 }],
      }),
    );
    await h.as(() => h.core.deps.db.scoped.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } }));
    const wf = await publishWorkflow(h, {
      name: 'scanner',
      trigger: {
        type: 'record_condition',
        entity: 'invoice',
        condition:
          "invoice.status in ['sent', 'overdue'] and invoice.dueDate < now() - days(1) and invoice.balanceCents > 100000",
        dedupe: 'invoice.id',
      },
      nodes: [{ id: 'e', type: 'end', config: {} }],
      edges: [{ from: '$trigger', to: 'e' }],
    });
    expect(await h.core.runs.scanConditions(new Date(), true)).toBe(1);
    expect(await h.core.runs.scanConditions(new Date(), true)).toBe(0);
    const runs = await h.core.deps.db.system.workflowRun.findMany({ where: { workflowId: wf } });
    expect(runs.map((r) => r.dedupeKey)).toEqual([inv.id]);
  });

  it('wait_for_event resumes on the domain event and ai_step uses the fake provider', async () => {
    const deal = await h.as(() => h.core.deals.create({ title: 'Event deal', amountCents: 100, currency: 'USD' }));
    const wf = await publishWorkflow(
      h,
      manual(
        'waiter',
        [
          {
            id: 'w',
            type: 'wait_for_event',
            config: { entity: 'deal', id: 'input.dealId', event: 'deal.won', timeout: 'days(1)' },
          },
          {
            id: 'ai',
            type: 'ai_step',
            config: { task: 'classify', input: 'The customer wants a refund', labels: ['refund', 'upgrade'] },
          },
        ],
        [
          { from: '$trigger', to: 'w' },
          { from: 'w', to: 'ai' },
        ],
        [{ key: 'dealId', label: 'Deal', type: 'string', required: true }],
      ),
    );
    const runId = await start(wf, { dealId: deal.id });
    expect(await waitRun(h, runId, ['waiting'])).toBe('waiting');
    const pipeline = await h.as(() => h.core.deals.defaultPipeline());
    await h.as(() => h.core.deals.move(deal.id, { stageId: pipeline.stages.find((s) => s.kind === 'won')!.id }));
    expect(await waitRun(h, runId, ['succeeded', 'failed'], 30_000)).toBe('succeeded');
    const s = await steps(runId);
    expect(s.find((x) => x.nodeId === 'w')?.outcome).toBe('next');
    expect((s.find((x) => x.nodeId === 'ai')?.output as { label: string }).label).toBe('refund');
  });

  it('external approvals deliver the decision to the callbackUrl with a signature', async () => {
    const approval = await h.as(() =>
      h.core.approvals.createExternal({
        title: 'Agent wants to void INV-1',
        details: { action: 'void_invoice' },
        assigneeRole: 'manager',
        callbackUrl: `${httpUrl}/callback-1`,
        idempotencyKey: 'agent-req-1',
      }),
    );
    const again = await h.as(() =>
      h.core.approvals.createExternal({
        title: 'Agent wants to void INV-1',
        details: {},
        assigneeRole: 'manager',
        callbackUrl: `${httpUrl}/callback-1`,
        idempotencyKey: 'agent-req-1',
      }),
    );
    expect(again.id).toBe(approval.id);
    expect(approval.source).toBe('agent');
    await h.as(() =>
      h.core.approvals.decide(approval.id, { decision: 'reject', comment: 'no' }, h.managerId, 'manager'),
    );
    await waitFor(async () => callbacks.length > 0, 20_000);
    expect(callbacks[0]?.body).toMatchObject({ approvalId: approval.id, status: 'rejected', comment: 'no' });
    expect(String(callbacks[0]?.headers['x-bop-signature'])).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('only one scheduler instance is leader; the other takes over when it stops', async () => {
    const key = `${h.core.config.redisPrefix}:test-leader`;
    const a = new LeaderLock(h.core.deps.redis, key, 'a', 1000, h.core.logger);
    const b = new LeaderLock(h.core.deps.redis, key, 'b', 1000, h.core.logger);
    expect(await a.tick()).toBe(true);
    expect(await b.tick()).toBe(false);
    await a.stop();
    expect(await b.tick()).toBe(true);
    await b.stop();
  });
});

async function runStatusOf(runId: string): Promise<string> {
  return (await h.core.deps.db.system.workflowRun.findUnique({ where: { id: runId } }))?.status ?? 'missing';
}
