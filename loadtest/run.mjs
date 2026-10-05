import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core, loadConfig, runInContext } from '../packages/core/dist/index.js';
import { createTestResources, deletePrefix, testEnv } from '../packages/core/dist/testing/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const RUNS = Number(args.runs ?? 10_000);
const WORKERS = String(args.workers ?? '1,2,4')
  .split(',')
  .map(Number);
const CONCURRENCY = Number(args.concurrency ?? 16);
const ENV_CACHE = String(args['env-cache'] ?? '5000');
const NOISY = args.noisy !== 'false';
const LABEL = String(args.label ?? 'run');
const SAMPLES = Number(args.samples ?? 10);
const NOISY_ONLY = args['noisy-only'] === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

let nextMetricsPort = 4570;

async function scrapeQueries(port) {
  try {
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    const m = /^db_queries_total(?:\{[^}]*\})? (\d+(?:\.\d+)?)/m.exec(text);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function spawnWorker(env, id) {
  const port = nextMetricsPort++;
  if (nextMetricsPort > 4579) nextMetricsPort = 4570;
  const child = spawn(process.execPath, [resolve(ROOT, 'apps/worker/dist/main.js')], {
    env: {
      ...process.env,
      ...env,
      WORKER_ID: id,
      STEP_CONCURRENCY: String(CONCURRENCY),
      LOG_LEVEL: 'error',
      REALTIME_URL: '',
      DB_COUNT_QUERIES: '1',
      WORKER_METRICS_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.metricsPort = port;
  return child;
}

async function killAll(children) {
  await Promise.all(
    children.map(
      (c) =>
        new Promise((r) => {
          if (c.exitCode !== null) return r();
          c.once('exit', r);
          c.kill('SIGTERM');
          setTimeout(() => c.kill('SIGKILL'), 8000);
        }),
    ),
  );
}

async function createTenant(core, slug, maxConcurrentSteps, extra = {}) {
  const owner = await core.accounts.createUser(`${slug}@load.test`, `Owner ${slug}`, 'pw-123456');
  const tenantId = await core.accounts.createTenant({
    slug,
    name: slug,
    ownerId: owner,
    settings: { maxConcurrentSteps, ...extra },
  });
  return { tenantId, owner, ctx: { tenantId, actor: { type: 'user', id: owner }, causation: [] } };
}

const definition = (name) => ({
  name,
  trigger: { type: 'manual' },
  nodes: [
    { id: 'check', type: 'condition', config: { expr: 'true' } },
    { id: 'task', type: 'create_task', config: { title: `${name} {{ run.id }}`, priority: 2 } },
    { id: 'end', type: 'end', config: {} },
  ],
  edges: [
    { from: '$trigger', to: 'check' },
    { from: 'check', to: 'task', label: 'true' },
    { from: 'task', to: 'end' },
  ],
});

async function publish(core, t, name) {
  return runInContext(t.ctx, async () => {
    const wf = await core.workflows.create({ name, definition: definition(name) });
    await core.workflows.publish(wf.id);
    return wf.id;
  });
}

let refusedTotal = 0;

async function startOne(core, t, wfId) {
  for (;;) {
    try {
      return await runInContext(t.ctx, async () => (await core.runs.manualRun(wfId, {})).id);
    } catch (error) {
      if (error?.status !== 429) throw error;
      refusedTotal += 1;
      const wait = Math.max(1, Number(error.details?.extra?.retryAfterMs ?? 20));
      await sleep(wait + Math.random() * wait);
    }
  }
}

async function startRuns(core, t, wfId, count, parallel = 8) {
  const ids = [];
  for (let i = 0; i < count; i += parallel) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(parallel, count - i) }, () => startOne(core, t, wfId)),
    );
    ids.push(...batch);
  }
  return ids;
}

async function waitAll(core, wfIds, expected, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = await core.deps.db.system.workflowRun.count({
      where: { workflowId: { in: wfIds }, status: { in: ['succeeded', 'failed'] } },
    });
    if (done >= expected) return Date.now() - t0;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${expected} runs`);
}

async function stepStats(core, wfIds) {
  const runs = await core.deps.db.system.workflowRun.findMany({
    where: { workflowId: { in: wfIds } },
    select: { id: true, status: true, startedAt: true, finishedAt: true },
  });
  const steps = await core.deps.db.system.stepRun.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, status: { not: 'skipped' } },
    select: {
      createdAt: true,
      pendingSince: true,
      scheduledFor: true,
      startedAt: true,
      finishedAt: true,
      attempt: true,
    },
  });
  const lag = steps
    .filter((s) => s.startedAt)
    .map((s) => s.startedAt.getTime() - (s.scheduledFor ?? s.createdAt).getTime());
  const runDur = runs.filter((r) => r.finishedAt).map((r) => r.finishedAt.getTime() - r.startedAt.getTime());
  return {
    runs: runs.length,
    failed: runs.filter((r) => r.status === 'failed').length,
    steps: steps.length,
    retried: steps.filter((s) => s.attempt > 1).length,
    queueLagMs: { p50: q(lag, 0.5), p95: q(lag, 0.95), p99: q(lag, 0.99) },
    runDurationMs: { p50: q(runDur, 0.5), p95: q(runDur, 0.95) },
  };
}

async function throughputRound(core, env, workers) {
  const t = await createTenant(core, `load-${workers}w-${Date.now()}`, 1000, { runsPerSecond: 0 });
  const wfId = await publish(core, t, `load ${workers}w`);
  await core.deps.queues.steps.pause();
  const t0 = Date.now();
  await startRuns(core, t, wfId, RUNS, 12);
  const enqueueMs = Date.now() - t0;
  const children = Array.from({ length: workers }, (_, i) =>
    spawnWorker({ ...env, OUTBOX_RELAY: i === 0 ? '1' : '0' }, `load-w${i + 1}`),
  );
  await sleep(2500);
  await core.deps.queues.steps.resume();
  const drainMs = await waitAll(core, [wfId], RUNS, 30 * 60_000);
  await sleep(1500);
  const queries = (await Promise.all(children.map((c) => scrapeQueries(c.metricsPort)))).reduce((a, b) => a + b, 0);
  await killAll(children);
  const stats = await stepStats(core, [wfId]);
  const result = {
    workers,
    runs: RUNS,
    enqueueSeconds: +(enqueueMs / 1000).toFixed(1),
    runCreationPerSec: Math.round(RUNS / (enqueueMs / 1000)),
    drainSeconds: +(drainMs / 1000).toFixed(1),
    stepsPerSec: Math.round(stats.steps / (drainMs / 1000)),
    runsPerSec: Math.round(RUNS / (drainMs / 1000)),
    workerQueries: queries,
    ...stats,
    queriesPerStep: +(queries / Math.max(1, stats.steps)).toFixed(1),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

async function noisyRound(core, env, fair, mode) {
  const a = await createTenant(
    core,
    `noisy-a-${fair}-${mode}-${Date.now()}`,
    8,
    mode === 'prequeued' ? { runsPerSecond: 0 } : {},
  );
  const b = await createTenant(core, `noisy-b-${fair}-${Date.now()}`, 8);
  const wfA = await publish(core, a, `noisy A ${fair}`);
  const wfB = await publish(core, b, `quiet B ${fair}`);
  const children = [1, 2].map((i) =>
    spawnWorker({ ...env, FAIR_SCHEDULING: fair ? '1' : '0', OUTBOX_RELAY: i === 1 ? '1' : '0' }, `noisy-w${i}`),
  );
  await sleep(2500);
  const measureB = async () => {
    const ids = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      ids.push(...(await startRuns(core, b, wfB, 1)));
      await sleep(150);
    }
    const t0 = Date.now();
    while (
      (await core.deps.db.system.workflowRun.count({ where: { id: { in: ids }, status: 'succeeded' } })) < ids.length &&
      Date.now() - t0 < 300_000
    )
      await sleep(200);
    const steps = await core.deps.db.system.stepRun.findMany({ where: { runId: { in: ids }, status: 'succeeded' } });
    return steps.map((s) => s.finishedAt.getTime() - s.createdAt.getTime());
  };
  await measureB();
  const baseline = await measureB();
  refusedTotal = 0;
  let creation = Promise.resolve([]);
  if (mode === 'prequeued') {
    await core.deps.queues.steps.pause();
    await startRuns(core, a, wfA, 5000, 12);
    await core.deps.queues.steps.resume();
  } else {
    creation = startRuns(core, a, wfA, 5000, 8);
  }
  await sleep(3000);
  const backlog = await core.deps.db.system.stepRun.count({ where: { tenantId: a.tenantId, status: 'pending' } });
  const loaded = await measureB();
  await creation;
  await killAll(children);
  const result = {
    fairScheduling: fair,
    creation: mode,
    refusedWith429: refusedTotal,
    tenantABacklogPendingSteps: backlog,
    baselineB: { p50: q(baseline, 0.5), p95: q(baseline, 0.95) },
    underLoadB: { p50: q(loaded, 0.5), p95: q(loaded, 0.95), max: Math.max(...loaded) },
    p95Ratio: +(q(loaded, 0.95) / Math.max(1, q(baseline, 0.95))).toFixed(2),
    p50Ratio: +(q(loaded, 0.5) / Math.max(1, q(baseline, 0.5))).toFixed(2),
    loadAverage: (await import('node:os')).loadavg()[0].toFixed(1),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await core.deps.db.system.workflow.update({ where: { id: wfA }, data: { status: 'paused' } });
  const leftover = await core.deps.db.system.workflowRun.findMany({
    where: { workflowId: wfA, status: { in: ['running', 'waiting'] } },
    select: { id: true },
  });
  await core.deps.db.system.stepRun.updateMany({
    where: { runId: { in: leftover.map((r) => r.id) }, status: { in: ['pending', 'waiting'] } },
    data: { status: 'cancelled' },
  });
  await core.deps.db.system.workflowRun.updateMany({
    where: { id: { in: leftover.map((r) => r.id) } },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
  return result;
}

const res = await createTestResources('load');
const env = testEnv(res, {
  LOG_LEVEL: 'error',
  SWEEP_INTERVAL_MS: '1000',
  LOST_NUDGE_AFTER_MS: '30000',
  ENV_CACHE_MS: ENV_CACHE,
  DB_POOL_SIZE: String(args.pool ?? 10),
});
const core = new Core({ service: 'loadtest', config: loadConfig({ ...process.env, ...env, REALTIME_URL: '' }) });
const started = new Date().toISOString();
const results = {
  label: LABEL,
  loadAverageAtStart: (await import('node:os')).loadavg().map((x) => +x.toFixed(1)),
  startedAt: started,
  machine: `${process.platform} ${process.arch}, node ${process.version}`,
  runs: RUNS,
  stepConcurrencyPerWorker: CONCURRENCY,
  envCacheMs: Number(ENV_CACHE),
  throughput: [],
  noisy: [],
};
try {
  if (!NOISY_ONLY) for (const w of WORKERS) results.throughput.push(await throughputRound(core, env, w));
  if (NOISY) {
    const modes = String(args['noisy-modes'] ?? 'concurrent,prequeued').split(',');
    for (const mode of modes)
      for (const fair of String(args['fair-modes'] ?? 'false,true')
        .split(',')
        .map((x) => x === 'true'))
        results.noisy.push(await noisyRound(core, env, fair, mode));
  }
} finally {
  await core.close().catch(() => undefined);
  await res.drop();
  await deletePrefix(res.redisUrl, res.redisPrefix).catch(() => undefined);
}
const out = resolve(ROOT, `docs/benchmarks/loadtest-${LABEL}-${started.slice(0, 10)}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`results written to ${out}\n`);
