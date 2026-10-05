import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@bop/contracts';
import { WorkerRuntime } from '../../src/runtime/worker';
import { createHarness, publishWorkflow, waitRun, type Harness } from './helpers';

interface Call {
  path: string;
  headers: IncomingHttpHeaders;
  body: { task: string; input: string; labels: string[]; context: Record<string, string> | null };
}

let h: Harness;
let runtime: WorkerRuntime;
let server: Server;
const calls: Call[] = [];
const hits = new Map<string, number>();

function listen(): Promise<number> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as Call['body'];
      calls.push({ path: req.url ?? '', headers: req.headers, body });
      const mode = body.input.split(':')[0] ?? '';
      const n = (hits.get(body.input) ?? 0) + 1;
      hits.set(body.input, n);
      if (mode === 'flaky' && n <= 2) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"busy"}');
        return;
      }
      if (mode === 'reject') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end('{"error":"unsupported"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          body.task === 'summarize'
            ? { summary: `Operator summary of ${body.input.length} chars`, confidence: 0.9 }
            : { label: body.labels[body.labels.length - 1] ?? null, confidence: 0.75 },
        ),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    }),
  );
}

function aiFlow(name: string, input: string, task = 'classify'): WorkflowDefinition {
  return {
    name,
    trigger: { type: 'manual' },
    nodes: [
      { id: 'ai', type: 'ai_step', config: { task, input, labels: ['refund', 'upgrade'] } },
      { id: 'fallback', type: 'create_task', config: { title: `Operator failed for ${name}` } },
    ],
    edges: [
      { from: '$trigger', to: 'ai' },
      { from: 'ai', to: 'fallback', label: 'error' },
    ],
  };
}

async function runOnce(wf: string): Promise<string> {
  const run = await h.as(() => h.core.runs.manualRun(wf, {}));
  return waitRun(h, run.id, ['succeeded', 'failed'], 60_000).then(() => run.id);
}

async function aiStepOf(runId: string) {
  return h.core.deps.db.system.stepRun.findFirst({ where: { runId, nodeId: 'ai' } });
}

beforeAll(async () => {
  const port = await listen();
  h = await createHarness('operator', {
    OPERATOR_URL: `http://127.0.0.1:${port}/integrations/bop/ai-step`,
    OPERATOR_TOKEN: 'operator-test-token',
    HTTP_TIMEOUT_MS: '5000',
  });
  runtime = new WorkerRuntime(h.core, { mail: false });
  await runtime.start();
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await runtime?.stop();
  await h?.res.drop();
});

describe('ai_step against the operator endpoint (OPERATOR_URL)', () => {
  it('selects the operator provider when OPERATOR_URL is set', () => {
    expect(h.core.config.ai.provider).toBe('operator');
  });

  it('classifies through the endpoint with the step idempotency key and the bearer token', async () => {
    const wf = await publishWorkflow(h, aiFlow('classify', 'ok: customer asks for an upgrade'));
    const runId = await runOnce(wf);
    const step = await aiStepOf(runId);
    expect(step?.status).toBe('succeeded');
    expect(step?.output).toMatchObject({ label: 'upgrade', confidence: 0.75, provider: 'operator' });
    const call = calls.find((c) => c.body.context?.['runId'] === runId);
    expect(call?.path).toBe('/integrations/bop/ai-step');
    expect(call?.headers['authorization']).toBe('Bearer operator-test-token');
    expect(call?.headers['idempotency-key']).toBe(step?.idempotencyKey);
    expect(call?.body).toMatchObject({
      task: 'classify',
      input: 'ok: customer asks for an upgrade',
      labels: ['refund', 'upgrade'],
      context: { tenantId: h.tenantId, workflowId: wf, runId, nodeId: 'ai' },
    });
  });

  it('summarizes through the endpoint', async () => {
    const wf = await publishWorkflow(h, aiFlow('summarize', 'ok: a long inbound email', 'summarize'));
    const step = await aiStepOf(await runOnce(wf));
    expect(step?.output).toMatchObject({ label: null, summary: 'Operator summary of 24 chars', provider: 'operator' });
  });

  it('retries 5xx with the same Idempotency-Key and records the effect once', async () => {
    const wf = await publishWorkflow(h, aiFlow('flaky', 'flaky: please classify'));
    const runId = await runOnce(wf);
    const step = await aiStepOf(runId);
    expect(step?.status).toBe('succeeded');
    expect(step?.attempt).toBe(3);
    const keys = calls.filter((c) => c.body.context?.['runId'] === runId).map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toEqual(new Set([step?.idempotencyKey]));
    const effects = await h.core.deps.db.system.effectLog.findMany({
      where: { idempotencyKey: step?.idempotencyKey ?? '' },
    });
    expect(effects.map((e) => [e.origin, e.effect])).toEqual([['engine', 'ai_step']]);
  });

  it('a 4xx answer is permanent and takes the error edge', async () => {
    const wf = await publishWorkflow(h, aiFlow('rejected', 'reject: nope'));
    const runId = await runOnce(wf);
    const step = await aiStepOf(runId);
    expect(step?.status).toBe('failed');
    expect(step?.attempt).toBe(1);
    expect((step?.error as { code: string }).code).toBe('operator_422');
    const tasks = await h.core.deps.db.system.task.count({ where: { title: 'Operator failed for rejected' } });
    expect(tasks).toBe(1);
  });

  it('test runs do not call the operator (dry run with the fake provider)', async () => {
    const before = calls.length;
    const wf = await publishWorkflow(h, aiFlow('test-run', 'ok: refund please'));
    const run = await h.as(() =>
      h.core.runs.testRun(wf, { definition: aiFlow('test-run', 'ok: refund please'), approvals: 'approve' }),
    );
    await waitRun(h, run.id, ['succeeded', 'failed']);
    const step = await aiStepOf(run.id);
    expect(step?.output).toMatchObject({ provider: 'fake', dryRun: true, label: 'refund' });
    expect(calls.length).toBe(before);
  });
});
