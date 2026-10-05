import { toJSON } from '@ashamrai/expr';
import { context as otelContext, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import type { CausationEntry, TenantSettings, WorkflowDefinition } from '@bop/contracts';
import {
  NODE_REGISTRY,
  backoffDelay,
  computeAdvance,
  nodeTypeContext,
  retryPolicyFor,
  scopeNodes,
  sinkOutputs,
  type NodeProgress,
} from '@bop/workflow-core';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { requireTenantId, runInContext, type ExecContext } from '../context';
import type { ScopedTx } from '../db/tenancy';
import { DomainError, isUniqueViolation, notFound, unprocessable } from '../errors';
import type { Approval, StepRun, WorkflowRun } from '../generated/prisma/client';
import type { StepJob } from '../queues';
import { channels } from '../realtime/publisher';
import { CancellationRegistry, RunRateLimiter, TenantSemaphore, type RateDecision } from './primitives';
import { loaded as loadDefinition, type LoadedDefinition } from './definitions';
import {
  buildEnv,
  resolveInput,
  secretNamesFor,
  type EnvSources,
  type RunContextJson,
  type TriggerPayloadJson,
} from './env';
import { classifyError, StepError } from './errors';
import { HANDLERS, type HandlerResult } from './handlers';
import type { EngineServices } from './types';
import { DEFAULT_SETTINGS } from '../services/accounts';

const ACTIVE = ['pending', 'running', 'waiting'];
const tracer = trace.getTracer('bop-workflow-engine');

export interface StartRunOptions {
  workflowId: string;
  version: number;
  triggerType: string;
  payload: TriggerPayloadJson;
  dedupeKey: string | null;
  causation: CausationEntry[];
  isTest?: boolean;
  testDefinition?: WorkflowDefinition;
  admission?: 'defer' | 'admitted';
}

interface Completion {
  status: 'succeeded' | 'failed' | 'cancelled';
  outcome: string | null;
  output: unknown;
  error?: { message: string; retryable: boolean; code: string } | null;
}

interface Tally {
  failed: boolean;
  statuses: string[];
}

interface AttemptEntry {
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  worker: string | null;
  error: { message: string; retryable: boolean; code?: string } | null;
}

function progressOf(row: Pick<StepRun, 'status' | 'outcome'>): NodeProgress {
  if (row.status === 'succeeded') return { status: 'done', outcome: row.outcome ?? 'next' };
  if (row.status === 'failed')
    return row.outcome === 'error' ? { status: 'done', outcome: 'error' } : { status: 'active' };
  if (row.status === 'skipped' || row.status === 'cancelled') return { status: 'skipped' };
  return { status: 'active' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export class Engine {
  readonly semaphore: TenantSemaphore;
  readonly runLimiter: RunRateLimiter;
  readonly cancels: CancellationRegistry;
  private readonly settingsCache = new Map<
    string,
    { at: number; settings: TenantSettings; tenant: { id: string; name: string; slug: string } }
  >();
  private readonly log: Logger;

  constructor(readonly s: EngineServices) {
    const { config, redis } = s.deps;
    this.semaphore = new TenantSemaphore(redis, config.redisPrefix, config.engine.leaseMs);
    this.runLimiter = new RunRateLimiter(
      redis,
      config.redisPrefix,
      config.engine.tenantRunRate,
      config.engine.tenantRunBurst,
    );
    this.cancels = new CancellationRegistry(redis, config.redisPrefix);
    this.log = s.deps.logger.child({ component: 'engine' });
    s.approvals.onDecided((a) => this.onApprovalDecided(a));
  }

  private get db() {
    return this.s.deps.db;
  }

  private get cfg() {
    return this.s.deps.config.engine;
  }

  private ctxFor(tenantId: string, run?: Pick<WorkflowRun, 'id' | 'workflowId' | 'causation' | 'isTest'>): ExecContext {
    if (run === undefined) return { tenantId, actor: { type: 'workflow', id: null }, causation: [] };
    const causation = [
      ...((run.causation ?? []) as unknown as CausationEntry[]),
      { runId: run.id, workflowId: run.workflowId },
    ];
    return { tenantId, actor: { type: 'workflow', id: run.id }, causation, isTest: run.isTest };
  }

  async tenantInfo(
    tenantId: string,
  ): Promise<{ settings: TenantSettings; tenant: { id: string; name: string; slug: string } }> {
    const hit = this.settingsCache.get(tenantId);
    if (hit !== undefined && Date.now() - hit.at < 10_000) return hit;
    const t = await this.db.system.tenant.findUnique({ where: { id: tenantId } });
    const value = {
      at: Date.now(),
      settings: { ...DEFAULT_SETTINGS, ...((t?.settings ?? {}) as Partial<TenantSettings>) },
      tenant: { id: tenantId, name: t?.name ?? '', slug: t?.slug ?? '' },
    };
    this.settingsCache.set(tenantId, value);
    return value;
  }

  async definitionFor(run: Pick<WorkflowRun, 'workflowId' | 'version' | 'testDefinition'>): Promise<LoadedDefinition> {
    if (run.testDefinition !== null && run.testDefinition !== undefined)
      return loadDefinition(run.testDefinition as unknown as WorkflowDefinition);
    return this.s.workflows.loadVersion(run.workflowId, run.version);
  }

  private readonly activeCache = new Map<string, { at: number; count: number }>();

  private async activeRuns(tenantId: string): Promise<number> {
    const hit = this.activeCache.get(tenantId);
    if (hit !== undefined && Date.now() - hit.at < 2000) {
      hit.count += 1;
      return hit.count;
    }
    const count = await this.db.scoped.workflowRun.count({
      where: { status: { in: ['running', 'waiting'] }, isTest: false },
    });
    this.activeCache.set(tenantId, { at: Date.now(), count });
    return count;
  }

  private async lockRun(tx: ScopedTx, runId: string): Promise<WorkflowRun | null> {
    const rows = await tx.workflowRun.updateManyAndReturn({
      where: { id: runId },
      data: { lockVersion: { increment: 1 } },
    });
    return rows[0] ?? null;
  }

  async admit(tenantId: string, mode: 'paced' | 'reserve'): Promise<RateDecision> {
    const { settings } = await this.tenantInfo(tenantId);
    const override = { ratePerSecond: settings.runsPerSecond, burst: settings.runBurst };
    const decision = await this.runLimiter.take(
      tenantId,
      'reserve',
      override,
      mode === 'paced' ? this.cfg.tenantRunMaxWaitMs : -1,
    );
    if (!decision.allowed) {
      this.s.deps.metrics.runsRateLimited.inc({ tenant: tenantId });
      throw new DomainError(
        429,
        'run_rate_limited',
        `Run creation rate limit (${override.ratePerSecond ?? this.runLimiter.ratePerSecond}/s) reached; retry in ${decision.delayMs} ms`,
        { extra: { retryAfterMs: decision.delayMs } },
      );
    }
    if (mode === 'paced' && decision.delayMs > 0) {
      this.s.deps.metrics.runsDeferred.inc({ tenant: tenantId });
      await sleep(decision.delayMs);
    }
    return decision;
  }

  async startRun(opts: StartRunOptions): Promise<{ runId: string; created: boolean }> {
    const tenantId = requireTenantId();
    const ld =
      opts.testDefinition !== undefined
        ? loadDefinition(opts.testDefinition)
        : await this.s.workflows.loadVersion(opts.workflowId, opts.version);
    const active = opts.isTest === true ? 0 : await this.activeRuns(tenantId);
    if (!opts.isTest && active >= this.cfg.maxActiveRunsPerTenant)
      throw new DomainError(429, 'run_limit', `Active run limit (${this.cfg.maxActiveRunsPerTenant}) reached`);
    if (opts.dedupeKey !== null) {
      const existing = await this.db.scoped.workflowRun.findFirst({
        where: { workflowId: opts.workflowId, dedupeKey: opts.dedupeKey },
        select: { id: true },
      });
      if (existing !== null) return { runId: existing.id, created: false };
    }
    let deferMs = 0;
    if (opts.isTest !== true && opts.admission !== 'admitted') {
      deferMs = (await this.admit(tenantId, 'reserve')).delayMs;
      if (deferMs > 0) this.s.deps.metrics.runsDeferred.inc({ tenant: tenantId });
    }
    let number = 0;
    if (JSON.stringify(ld.definition).includes('run.number')) {
      const updated = await this.db.scoped.workflow.update({
        where: { id: opts.workflowId },
        data: { runCounter: { increment: 1 } },
        select: { runCounter: true },
      });
      number = updated.runCounter;
    }
    const carrier: Record<string, string> = {};
    const span = tracer.startSpan('workflow.run', {
      attributes: { 'workflow.id': opts.workflowId, 'workflow.version': opts.version, 'tenant.id': tenantId },
    });
    propagation.inject(trace.setSpan(otelContext.active(), span), carrier);
    span.end();
    const runId = randomUUID();
    const jobs: StepJob[] = [];
    try {
      await this.db.scoped.$transaction(async (tx) => {
        const run = await tx.workflowRun.create({
          data: {
            id: runId,
            tenantId,
            workflowId: opts.workflowId,
            version: opts.version,
            status: 'running',
            triggerType: opts.triggerType,
            triggerPayload: { ...opts.payload, trace: carrier } as never,
            context: { steps: {} } as never,
            dedupeKey: opts.dedupeKey,
            causation: opts.causation as never,
            isTest: opts.isTest === true,
            testDefinition: (opts.testDefinition ?? undefined) as never,
            number,
          },
        });
        await this.progress(tx, run, ld, { steps: {} }, null, 0, jobs);
        if (deferMs > 0 && jobs.length > 0)
          await tx.stepRun.updateMany({
            where: { id: { in: jobs.map((j) => j.stepRunId) } },
            data: { scheduledFor: new Date(Date.now() + deferMs) },
          });
      });
    } catch (error) {
      if (opts.dedupeKey !== null && isUniqueViolation(error)) {
        const existing = await this.db.scoped.workflowRun.findFirst({
          where: { workflowId: opts.workflowId, dedupeKey: opts.dedupeKey },
          select: { id: true },
        });
        if (existing !== null) return { runId: existing.id, created: false };
      }
      throw error;
    }
    await this.s.deps.queues.nudgeSteps(jobs, deferMs);
    return { runId, created: true };
  }

  private async createSteps(
    tx: ScopedTx,
    run: WorkflowRun,
    ld: LoadedDefinition,
    ids: string[],
    iteration: number,
    status: 'pending' | 'skipped',
    jobs: StepJob[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const rows = ids.map((nodeId) => {
      const node = ld.graph.nodes.get(nodeId);
      if (node === undefined) throw new Error(`Unknown node ${nodeId}`);
      return {
        id: randomUUID(),
        runId: run.id,
        tenantId: run.tenantId,
        nodeId,
        nodeType: node.type,
        iteration,
        status,
        maxAttempts: retryPolicyFor(node).maxAttempts,
        idempotencyKey: `${run.id}:${nodeId}:${iteration}`,
        pendingSince: status === 'pending' ? now : null,
        finishedAt: status === 'skipped' ? now : null,
      };
    });
    const created = await tx.stepRun.createManyAndReturn({
      data: rows,
      skipDuplicates: true,
      select: { id: true, status: true },
    });
    for (const r of created) if (r.status === 'pending') jobs.push({ stepRunId: r.id, tenantId: run.tenantId });
    return created.map((r) => r.status);
  }

  private progressMap(
    rows: Array<Pick<StepRun, 'nodeId' | 'iteration' | 'status' | 'outcome'>>,
    ld: LoadedDefinition,
    scope: string | null,
    iteration: number,
  ): Map<string, NodeProgress> {
    const map = new Map<string, NodeProgress>();
    for (const r of rows) {
      const owner = ld.graph.bodyOf.get(r.nodeId) ?? null;
      if (owner !== scope) continue;
      if (scope !== null && r.iteration !== iteration) continue;
      map.set(r.nodeId, progressOf(r));
    }
    return map;
  }

  private async progress(
    tx: ScopedTx,
    run: WorkflowRun,
    ld: LoadedDefinition,
    ctx: RunContextJson,
    scope: string | null,
    iteration: number,
    jobs: StepJob[],
  ): Promise<Tally> {
    let rows = await tx.stepRun.findMany({
      where: { runId: run.id },
      select: { id: true, nodeId: true, iteration: true, status: true, outcome: true, output: true },
    });
    const map = this.progressMap(rows, ld, scope, iteration);
    const adv = computeAdvance(ld.graph, scope, map);
    const total = rows.length + adv.create.length + adv.skip.length;
    if (total > this.cfg.maxStepsPerRun) {
      await this.failRunInTx(tx, run, ctx, {
        message: `Step limit (${this.cfg.maxStepsPerRun}) exceeded`,
        nodeId: null,
      });
      return { failed: true, statuses: [] };
    }
    const created = [
      ...(await this.createSteps(tx, run, ld, adv.skip, iteration, 'skipped', jobs)),
      ...(await this.createSteps(tx, run, ld, adv.create, iteration, 'pending', jobs)),
    ];
    const tally: Tally = { failed: false, statuses: [...rows.map((r) => r.status), ...created] };
    if (scope !== null) {
      rows = await tx.stepRun.findMany({
        where: { runId: run.id },
        select: { id: true, nodeId: true, iteration: true, status: true, outcome: true, output: true },
      });
      const fresh: Tally = { failed: false, statuses: rows.map((r) => r.status) };
      const iterMap = this.progressMap(rows, ld, scope, iteration);
      const settled = scopeNodes(ld.graph, scope).every((id) => {
        const p = iterMap.get(id);
        return p === undefined || p.status !== 'active';
      });
      if (!settled) return fresh;
      const loop = ctx.loops?.[scope];
      if (loop === undefined) return fresh;
      const sinks = sinkOutputs(ld.graph, scope, iterMap);
      const outputs = sinks.map((id) => rows.find((r) => r.nodeId === id && r.iteration === iteration)?.output ?? null);
      loop.results[iteration - 1] =
        outputs.length === 1 ? outputs[0] : Object.fromEntries(sinks.map((id, i) => [id, outputs[i]]));
      loop.done += 1;
      if (loop.next < loop.items.length) {
        loop.next += 1;
        return {
          failed: false,
          statuses: [...fresh.statuses, ...(await this.startIteration(tx, run, ld, scope, loop.next, jobs))],
        };
      }
      if (loop.done >= loop.items.length) return (await this.completeLoop(tx, run, ld, ctx, scope, jobs)) ?? fresh;
      return fresh;
    }
    return tally;
  }

  private async startIteration(
    tx: ScopedTx,
    run: WorkflowRun,
    ld: LoadedDefinition,
    scope: string,
    iteration: number,
    jobs: StepJob[],
  ): Promise<string[]> {
    const adv = computeAdvance(ld.graph, scope, new Map());
    return [
      ...(await this.createSteps(tx, run, ld, adv.skip, iteration, 'skipped', jobs)),
      ...(await this.createSteps(tx, run, ld, adv.create, iteration, 'pending', jobs)),
    ];
  }

  private async completeLoop(
    tx: ScopedTx,
    run: WorkflowRun,
    ld: LoadedDefinition,
    ctx: RunContextJson,
    scope: string,
    jobs: StepJob[],
  ): Promise<Tally | null> {
    const loop = ctx.loops?.[scope];
    const output = { count: loop?.items.length ?? 0, results: loop?.results ?? [] };
    const res = await tx.stepRun.updateMany({
      where: { runId: run.id, nodeId: scope, iteration: 0, status: 'waiting' },
      data: {
        status: 'succeeded',
        outcome: 'done',
        output: output as never,
        finishedAt: new Date(),
        wait: undefined,
        waitKey: null,
      },
    });
    if (res.count === 0) return null;
    ctx.steps = { ...(ctx.steps ?? {}), [scope]: { output, status: 'succeeded', outcome: 'done' } };
    return this.progress(tx, run, ld, ctx, null, 0, jobs);
  }

  private async finishIfIdle(tx: ScopedTx, run: WorkflowRun, ctx: RunContextJson, tally?: Tally): Promise<string> {
    const statuses =
      tally?.statuses ??
      (await tx.stepRun.findMany({ where: { runId: run.id }, select: { status: true } })).map((r) => r.status);
    const active = statuses.filter((st) => ACTIVE.includes(st)).length;
    const working = statuses.filter((st) => st === 'pending' || st === 'running').length;
    const status = active === 0 ? 'succeeded' : working === 0 ? 'waiting' : 'running';
    const total = statuses.length;
    await tx.workflowRun.update({
      where: { id: run.id },
      data: { context: ctx as never, status, stepCount: total, finishedAt: status === 'succeeded' ? new Date() : null },
    });
    return status;
  }

  private async failRunInTx(
    tx: ScopedTx,
    run: WorkflowRun,
    ctx: RunContextJson,
    error: { message: string; nodeId: string | null },
  ): Promise<void> {
    await tx.stepRun.updateMany({
      where: { runId: run.id, status: { in: ['pending', 'waiting'] } },
      data: {
        status: 'cancelled',
        error: { message: 'Run failed', code: 'run_failed', retryable: false } as never,
        finishedAt: new Date(),
        waitKey: null,
      },
    });
    await this.s.approvals.cancelForRun(tx, run.id);
    await tx.workflowRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: error as never, finishedAt: new Date(), context: ctx as never },
    });
  }

  private appendAttempt(step: StepRun, entry: Partial<AttemptEntry>): AttemptEntry[] {
    const list = Array.isArray(step.attempts) ? [...(step.attempts as unknown as AttemptEntry[])] : [];
    const idx = list.findIndex((a) => a.attempt === step.attempt);
    const base: AttemptEntry =
      idx >= 0
        ? (list[idx] as AttemptEntry)
        : {
            attempt: step.attempt,
            startedAt: step.startedAt?.toISOString() ?? null,
            finishedAt: null,
            worker: step.leaseOwner,
            error: null,
          };
    const merged = { ...base, ...entry };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    return list.slice(-50);
  }

  private async afterTransition(
    run: WorkflowRun,
    jobs: StepJob[],
    nodeId: string,
    status: string,
    runStatus: string | null,
  ): Promise<void> {
    await this.s.deps.queues.nudgeSteps(jobs);
    if (run.isTest || runStatus === 'succeeded' || runStatus === 'failed') {
      await this.s.deps.realtime.publish(channels.run(run.tenantId, run.id), {
        type: 'step',
        nodeId,
        status,
        runStatus,
      });
    }
    if (runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled')
      this.s.deps.metrics.runsTotal.inc({ status: runStatus });
  }

  async completeStep(
    stepId: string,
    tenantId: string,
    completion: Completion,
    guard: { from: 'running' | 'waiting'; owner?: string; runId?: string; input?: unknown },
  ): Promise<boolean> {
    return runInContext(this.ctxFor(tenantId), async () => {
      const jobs: StepJob[] = [];
      let runRef: WorkflowRun | null = null;
      let nodeId = '';
      let runStatus: string | null = null;
      const ok = await this.db.scoped.$transaction(async (tx) => {
        const runId =
          guard.runId ?? (await tx.stepRun.findFirst({ where: { id: stepId }, select: { runId: true } }))?.runId;
        if (runId === undefined) return false;
        const run = await this.lockRun(tx, runId);
        if (run === null) return false;
        const step = await tx.stepRun.findFirst({ where: { id: stepId } });
        if (
          step === null ||
          step.runId !== runId ||
          step.status !== guard.from ||
          (guard.owner !== undefined && step.leaseOwner !== guard.owner)
        )
          return false;
        runRef = run;
        nodeId = step.nodeId;
        const ld = await this.definitionFor(run);
        const outputJson = (toJSON(completion.output) ?? null) as never;
        await tx.stepRun.update({
          where: { id: stepId },
          data: {
            ...(guard.input === undefined ? {} : { input: guard.input as never }),
            status: completion.status,
            outcome: completion.outcome,
            output: outputJson,
            error: (completion.error ?? undefined) as never,
            finishedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            waitKey: null,
            attempts: this.appendAttempt(step, {
              finishedAt: new Date().toISOString(),
              error: completion.error ?? null,
            }) as never,
          },
        });
        if (run.status !== 'running' && run.status !== 'waiting') return true;
        const ctx = (run.context ?? {}) as RunContextJson;
        const scope = ld.graph.bodyOf.get(step.nodeId) ?? null;
        const entry = { output: outputJson as unknown, status: completion.status, outcome: completion.outcome };
        if (scope === null) ctx.steps = { ...(ctx.steps ?? {}), [step.nodeId]: entry };
        else {
          ctx.iterations ??= {};
          ctx.iterations[scope] ??= {};
          ctx.iterations[scope][String(step.iteration)] = {
            ...(ctx.iterations[scope][String(step.iteration)] ?? {}),
            [step.nodeId]: entry,
          };
        }
        if (completion.status === 'failed' && completion.outcome !== 'error') {
          await this.failRunInTx(tx, run, ctx, {
            message: completion.error?.message ?? 'Step failed',
            nodeId: step.nodeId,
          });
          runStatus = 'failed';
          return true;
        }
        if (completion.status === 'cancelled') {
          runStatus = await this.finishIfIdle(tx, run, ctx);
          return true;
        }
        const tally = await this.progress(tx, run, ld, ctx, scope, step.iteration, jobs);
        if (tally.failed) {
          runStatus = 'failed';
          return true;
        }
        runStatus = await this.finishIfIdle(tx, run, ctx, tally);
        return true;
      });
      if (ok && runRef !== null) {
        await this.afterTransition(runRef, jobs, nodeId, completion.status, runStatus);
        if (runStatus === 'failed')
          await this.notifyFailure(runRef, completion.error?.message ?? 'Step failed', nodeId);
      }
      return ok;
    });
  }

  private async notifyFailure(run: WorkflowRun, message: string, nodeId: string): Promise<void> {
    if (run.isTest) return;
    const wf = await this.db.scoped.workflow.findFirst({
      where: { id: run.workflowId },
      select: { createdBy: true, name: true },
    });
    if (wf?.createdBy) {
      await this.s.notifications.notify(
        [wf.createdBy],
        'workflow.failed',
        { runId: run.id, workflowId: run.workflowId, workflow: wf.name, nodeId, message },
        `run-failed:${run.id}`,
      );
    }
  }

  private async toWaiting(
    stepId: string,
    tenantId: string,
    owner: string,
    result: Extract<HandlerResult, { kind: 'wait' }>,
    runId: string,
    input: unknown,
  ): Promise<boolean> {
    return runInContext(this.ctxFor(tenantId), async () => {
      let runRef: WorkflowRun | null = null;
      let nodeId = '';
      let runStatus: string | null = null;
      const ok = await this.db.scoped.$transaction(async (tx) => {
        const run = await this.lockRun(tx, runId);
        if (run === null) return false;
        const step = await tx.stepRun.findFirst({ where: { id: stepId } });
        if (step === null || step.status !== 'running' || step.leaseOwner !== owner) return false;
        runRef = run;
        nodeId = step.nodeId;
        await tx.stepRun.update({
          where: { id: stepId },
          data: {
            input: input as never,
            status: 'waiting',
            wait: result.wait as never,
            waitKey: result.waitKey,
            scheduledFor: result.until,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        runStatus = await this.finishIfIdle(tx, run, (run.context ?? {}) as RunContextJson);
        return true;
      });
      if (ok && runRef !== null) {
        await this.afterTransition(runRef, [], nodeId, 'waiting', runStatus);
        if (result.until !== null) {
          const delay = Math.max(0, result.until.getTime() - Date.now());
          if (delay < 7 * 86_400_000)
            await this.s.deps.queues.steps.add(
              'timer',
              { stepRunId: stepId, tenantId, kind: 'timer' },
              { delay, removeOnComplete: true, removeOnFail: 100 },
            );
        }
      }
      return ok;
    });
  }

  private async startLoop(
    stepId: string,
    tenantId: string,
    owner: string,
    result: Extract<HandlerResult, { kind: 'loop' }>,
    runId: string,
    input: unknown,
  ): Promise<boolean> {
    return runInContext(this.ctxFor(tenantId), async () => {
      const jobs: StepJob[] = [];
      let runRef: WorkflowRun | null = null;
      let nodeId = '';
      let runStatus: string | null = null;
      const ok = await this.db.scoped.$transaction(async (tx) => {
        const run = await this.lockRun(tx, runId);
        if (run === null) return false;
        const step = await tx.stepRun.findFirst({ where: { id: stepId } });
        if (step === null || step.status !== 'running' || step.leaseOwner !== owner) return false;
        runRef = run;
        nodeId = step.nodeId;
        const ld = await this.definitionFor(run);
        const ctx = (run.context ?? {}) as RunContextJson;
        const items = (toJSON(result.items) ?? []) as unknown[];
        const first = Math.min(result.concurrency, items.length);
        ctx.loops = {
          ...(ctx.loops ?? {}),
          [step.nodeId]: { items, next: first, done: 0, results: [], concurrency: result.concurrency },
        };
        await tx.stepRun.update({
          where: { id: stepId },
          data: {
            input: input as never,
            status: 'waiting',
            wait: { kind: 'for_each', total: items.length } as never,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        if (items.length === 0) await this.completeLoop(tx, run, ld, ctx, step.nodeId, jobs);
        else for (let i = 1; i <= first; i += 1) await this.startIteration(tx, run, ld, step.nodeId, i, jobs);
        runStatus = await this.finishIfIdle(tx, run, ctx);
        return true;
      });
      if (ok && runRef !== null) await this.afterTransition(runRef, jobs, nodeId, 'waiting', runStatus);
      return ok;
    });
  }

  private readonly sourceCache = new Map<
    string,
    { at: number; value: Promise<{ custom: EnvSources['custom']; members: EnvSources['members'] }> }
  >();

  private tenantSources(tenantId: string): Promise<{ custom: EnvSources['custom']; members: EnvSources['members'] }> {
    const ttl = this.cfg.envCacheMs;
    const hit = this.sourceCache.get(tenantId);
    if (ttl > 0 && hit !== undefined && Date.now() - hit.at < ttl) return hit.value;
    const value = Promise.all([this.s.customFields.map(), this.s.directory.members()]).then(([custom, members]) => ({
      custom,
      members,
    }));
    if (ttl > 0) {
      this.sourceCache.set(tenantId, { at: Date.now(), value });
      value.catch(() => this.sourceCache.delete(tenantId));
    }
    return value;
  }

  private async envSources(
    tenantId: string,
    node: { type: string; config: Record<string, unknown> } & Parameters<typeof secretNamesFor>[0],
  ): Promise<EnvSources> {
    const [{ custom, members }, info] = await Promise.all([this.tenantSources(tenantId), this.tenantInfo(tenantId)]);
    const secretNames = secretNamesFor(node);
    const secrets = secretNames.length === 0 ? new Map<string, string>() : await this.s.secrets.resolve(secretNames);
    return { custom, members, secrets, tenant: info.tenant };
  }

  async processJob(data: { stepRunId: string; tenantId: string; kind?: string }): Promise<string> {
    if (data.kind === 'timer')
      return (await this.handleTimer(data.stepRunId, data.tenantId)) ? 'timer-fired' : 'timer-noop';
    await this.s.deps.queues.stepStarted(data.tenantId).catch(() => undefined);
    return this.processStep(data.stepRunId, data.tenantId);
  }

  private async throttleDelay(tenantId: string, limit: number): Promise<number> {
    const backlog = Number(await this.s.deps.redis.get(this.s.deps.queues.backlogKey(tenantId)).catch(() => '1')) || 1;
    const spread = Math.min(30_000, this.cfg.throttleRetryMs * Math.max(1, Math.ceil(backlog / (limit * 4))));
    return this.cfg.throttleRetryMs + Math.floor(Math.random() * spread);
  }

  async processStep(stepRunId: string, tenantId: string): Promise<string> {
    const owner = `${this.cfg.workerId}:${randomUUID().slice(0, 8)}`;
    return runInContext(this.ctxFor(tenantId), async () => {
      const { settings } = await this.tenantInfo(tenantId);
      const limit = Math.max(1, settings.maxConcurrentSteps ?? this.cfg.tenantMaxConcurrentSteps);
      const park = this.cfg.fairScheduling;
      if (!(await this.semaphore.acquire(tenantId, stepRunId, limit, park))) {
        this.s.deps.metrics.tenantThrottled.inc({ tenant: tenantId });
        if (park) return 'parked';
        await this.s.deps.queues.nudgeSteps([{ stepRunId, tenantId }], await this.throttleDelay(tenantId, limit));
        return 'throttled';
      }
      try {
        const now = new Date();
        const claimed = await this.db.scoped.stepRun.updateManyAndReturn({
          where: { id: stepRunId, status: 'pending', OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
          data: {
            status: 'running',
            attempt: { increment: 1 },
            leaseOwner: owner,
            leaseExpiresAt: new Date(now.getTime() + this.cfg.leaseMs),
            startedAt: now,
          },
        });
        const step = claimed[0];
        if (step === undefined) return 'not-claimed';
        this.s.deps.metrics.stepQueueLag.observe(
          Math.max(0, now.getTime() - (step.scheduledFor ?? step.pendingSince ?? step.createdAt).getTime()) / 1000,
        );
        const run = await this.db.scoped.workflowRun.findFirst({ where: { id: step.runId } });
        if (run === null || (run.status !== 'running' && run.status !== 'waiting')) {
          await this.db.scoped.stepRun.updateMany({
            where: { id: stepRunId, leaseOwner: owner },
            data: { status: 'cancelled', leaseOwner: null, finishedAt: new Date() },
          });
          return 'run-inactive';
        }
        return await this.execute(run, step, owner);
      } finally {
        const next = await this.semaphore.release(tenantId, stepRunId, park ? limit : 0).catch(() => []);
        if (next.length > 0)
          await this.s.deps.queues
            .nudgeSteps(next.map((id) => ({ stepRunId: id, tenantId })))
            .catch((error: unknown) => this.log.warn({ err: error, tenantId }, 'unpark nudge failed'));
      }
    });
  }

  private async execute(run: WorkflowRun, step: StepRun, owner: string): Promise<string> {
    const ld = await this.definitionFor(run);
    const node = ld.graph.nodes.get(step.nodeId);
    if (node === undefined) {
      await this.completeStep(
        step.id,
        run.tenantId,
        {
          status: 'failed',
          outcome: null,
          output: null,
          error: { message: `Node ${step.nodeId} not in definition`, retryable: false, code: 'definition' },
        },
        { from: 'running', owner },
      );
      return 'failed';
    }
    const carrier = ((run.triggerPayload as { trace?: Record<string, string> }).trace ?? {}) as Record<string, string>;
    const parent = propagation.extract(otelContext.active(), carrier);
    return tracer.startActiveSpan(
      `workflow.step ${node.type}`,
      { attributes: { 'workflow.run_id': run.id, 'workflow.node_id': node.id, 'workflow.attempt': step.attempt } },
      parent,
      async (span) => {
        const started = process.hrtime.bigint();
        const controller = new AbortController();
        const unregister = this.cancels.register(run.id, controller);
        const timers: NodeJS.Timeout[] = [];
        if (node.timeoutMs !== undefined)
          timers.push(
            setTimeout(
              () => controller.abort(new StepError(`Step timed out after ${node.timeoutMs} ms`, true, 'timeout')),
              node.timeoutMs,
            ),
          );
        const heartbeat = setInterval(() => {
          void (async () => {
            const res = await this.db.system.stepRun.updateMany({
              where: { id: step.id, leaseOwner: owner, status: 'running' },
              data: { leaseExpiresAt: new Date(Date.now() + this.cfg.leaseMs) },
            });
            if (res.count === 0) controller.abort(new StepError('Lease lost', true, 'lease_lost'));
            await this.semaphore.extend(run.tenantId, step.id).catch(() => undefined);
          })().catch(() => undefined);
        }, this.cfg.heartbeatMs);
        let outcomeLabel = 'unknown';
        let inputJson: unknown = undefined;
        try {
          const result = await runInContext(this.ctxFor(run.tenantId, run), async () => {
            const sources = await this.envSources(run.tenantId, node);
            const env = buildEnv(run, step, ld, sources);
            const resolved = resolveInput(node, env, sources.secrets);
            inputJson = resolved.json;
            const typeCtx = nodeTypeContext(ld.definition, ld.graph, node.id, { custom: sources.custom });
            const testApprovals = (
              (run.triggerPayload as { testApprovals?: string }).testApprovals === 'reject' ? 'reject' : 'approve'
            ) as 'approve' | 'reject';
            const r = await HANDLERS[node.type]({
              s: this.s,
              run,
              step,
              node,
              loaded: ld,
              input: resolved.values,
              env,
              typeCtx,
              idempotencyKey: step.idempotencyKey,
              signal: controller.signal,
              isTest: run.isTest,
              testApprovals,
            });
            if (
              this.cfg.testEffectDelayMs > 0 &&
              (this.cfg.testEffectDelayNode === null || this.cfg.testEffectDelayNode === node.id) &&
              !run.isTest
            ) {
              this.log.info(
                { stepId: step.id, nodeId: node.id, delayMs: this.cfg.testEffectDelayMs },
                'test effect delay',
              );
              await sleep(this.cfg.testEffectDelayMs, controller.signal);
            }
            return r;
          });
          if (controller.signal.aborted) throw controller.signal.reason ?? new StepError('aborted', true, 'aborted');
          if (result.kind === 'done') {
            await this.completeStep(
              step.id,
              run.tenantId,
              { status: 'succeeded', outcome: result.outcome, output: result.output, error: null },
              { from: 'running', owner, runId: run.id, input: inputJson },
            );
            outcomeLabel = result.outcome;
          } else if (result.kind === 'wait') {
            await this.toWaiting(step.id, run.tenantId, owner, result, run.id, inputJson);
            outcomeLabel = 'waiting';
          } else {
            await this.startLoop(step.id, run.tenantId, owner, result, run.id, inputJson);
            outcomeLabel = 'loop';
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return outcomeLabel;
        } catch (error) {
          const reason = controller.signal.aborted ? controller.signal.reason : error;
          const cancelled = reason instanceof Error && reason.message === 'run cancelled';
          if (cancelled) {
            await this.completeStep(
              step.id,
              run.tenantId,
              {
                status: 'cancelled',
                outcome: null,
                output: null,
                error: { message: 'Run cancelled', retryable: false, code: 'cancelled' },
              },
              { from: 'running', owner, runId: run.id, input: inputJson },
            );
            return 'cancelled';
          }
          const c = classifyError(reason);
          span.recordException(reason as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: c.message });
          outcomeLabel = await this.handleFailure(run, step, owner, c, ld, inputJson);
          return outcomeLabel;
        } finally {
          clearInterval(heartbeat);
          for (const t of timers) clearTimeout(t);
          unregister();
          this.s.deps.metrics.stepDuration.observe(
            { type: node.type, result: outcomeLabel },
            Number(process.hrtime.bigint() - started) / 1e9,
          );
          span.end();
        }
      },
    );
  }

  private async handleFailure(
    run: WorkflowRun,
    step: StepRun,
    owner: string,
    c: { message: string; retryable: boolean; code: string },
    ld: LoadedDefinition,
    input: unknown,
  ): Promise<string> {
    const node = ld.graph.nodes.get(step.nodeId);
    const policy =
      node === undefined ? { maxAttempts: 1, backoff: 'fixed' as const, initialMs: 1000 } : retryPolicyFor(node);
    if (c.retryable && step.attempt < step.maxAttempts) {
      const delay = backoffDelay(policy, step.attempt);
      const res = await runInContext(this.ctxFor(run.tenantId), () =>
        this.db.scoped.stepRun.updateMany({
          where: { id: step.id, leaseOwner: owner, status: 'running' },
          data: {
            ...(input === undefined ? {} : { input: input as never }),
            status: 'pending',
            scheduledFor: new Date(Date.now() + delay),
            pendingSince: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            error: c as never,
            attempts: this.appendAttempt(step, { finishedAt: new Date().toISOString(), error: c }) as never,
          },
        }),
      );
      if (res.count > 0) await this.s.deps.queues.nudgeSteps([{ stepRunId: step.id, tenantId: run.tenantId }], delay);
      return 'retry';
    }
    const hasErrorEdge =
      node !== undefined &&
      NODE_REGISTRY[node.type].errorEdge &&
      (ld.graph.out.get(node.id) ?? []).some((e) => e.label === 'error');
    await this.completeStep(
      step.id,
      run.tenantId,
      {
        status: 'failed',
        outcome: hasErrorEdge ? 'error' : null,
        output: hasErrorEdge ? { error: c.message, code: c.code } : null,
        error: c,
      },
      { from: 'running', owner, runId: run.id, input },
    );
    return hasErrorEdge ? 'error-edge' : 'failed';
  }

  async handleTimer(stepId: string, tenantId: string): Promise<boolean> {
    return runInContext(this.ctxFor(tenantId), async () => {
      const step = await this.db.scoped.stepRun.findFirst({ where: { id: stepId } });
      if (
        step === null ||
        step.status !== 'waiting' ||
        step.scheduledFor === null ||
        step.scheduledFor.getTime() > Date.now()
      )
        return false;
      const wait = (step.wait ?? {}) as { kind?: string; approvalId?: string };
      this.s.deps.metrics.timerLag.observe(Math.max(0, Date.now() - step.scheduledFor.getTime()) / 1000);
      if (wait.kind === 'approval' && wait.approvalId !== undefined) {
        const approval = await this.db.scoped.approval.findFirst({ where: { id: wait.approvalId } });
        if (approval !== null && approval.status === 'pending') {
          await this.s.approvals.expire(approval);
          return true;
        }
        if (approval !== null) return this.resumeFromApproval(approval);
      }
      if (wait.kind === 'event')
        return this.completeStep(
          stepId,
          tenantId,
          { status: 'succeeded', outcome: 'timeout', output: { event: null, payload: null }, error: null },
          { from: 'waiting' },
        );
      if (wait.kind === 'for_each') return false;
      return this.completeStep(
        stepId,
        tenantId,
        { status: 'succeeded', outcome: 'next', output: { resumedAt: new Date().toISOString() }, error: null },
        { from: 'waiting' },
      );
    });
  }

  private async resumeFromApproval(approval: Approval): Promise<boolean> {
    const ref = (approval.sourceRef ?? {}) as { stepRunId?: string };
    if (approval.source !== 'workflow' || ref.stepRunId === undefined) return false;
    const outcome =
      approval.status === 'approved' ? 'approved' : approval.status === 'rejected' ? 'rejected' : 'timeout';
    let decidedBy: unknown = null;
    if (approval.decidedBy !== null)
      decidedBy = (await this.s.directory.usersById([approval.decidedBy])).get(approval.decidedBy) ?? null;
    return this.completeStep(
      ref.stepRunId,
      approval.tenantId,
      {
        status: 'succeeded',
        outcome,
        output: { decision: approval.status, decidedBy, comment: approval.comment },
        error: null,
      },
      { from: 'waiting' },
    );
  }

  async onApprovalDecided(approval: Approval): Promise<void> {
    if (approval.status === 'cancelled') return;
    await this.resumeFromApproval(approval);
  }

  async resumeEvent(
    tenantId: string,
    entity: string,
    entityId: string,
    type: string,
    payload: unknown,
  ): Promise<number> {
    return runInContext(this.ctxFor(tenantId), async () => {
      const waiting = await this.db.scoped.stepRun.findMany({
        where: { status: 'waiting', waitKey: `event:${entity}:${entityId}:${type}` },
        select: { id: true },
      });
      let resumed = 0;
      for (const w of waiting) {
        if (
          await this.completeStep(
            w.id,
            tenantId,
            { status: 'succeeded', outcome: 'next', output: { event: type, payload }, error: null },
            { from: 'waiting' },
          )
        )
          resumed += 1;
      }
      return resumed;
    });
  }

  async cancelRun(runId: string): Promise<void> {
    const tenantId = requireTenantId();
    const changed = await this.db.scoped.$transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run === null) throw notFound('Run');
      if (run.status !== 'running' && run.status !== 'waiting') return false;
      await tx.stepRun.updateMany({
        where: { runId, status: { in: ['pending', 'waiting'] } },
        data: { status: 'cancelled', finishedAt: new Date(), waitKey: null },
      });
      await this.s.approvals.cancelForRun(tx, runId);
      await tx.workflowRun.update({
        where: { id: runId },
        data: { status: 'cancelled', finishedAt: new Date(), error: { message: 'Cancelled by user' } as never },
      });
      return true;
    });
    if (changed) {
      await this.cancels.broadcast(runId);
      this.s.deps.metrics.runsTotal.inc({ status: 'cancelled' });
      await this.s.deps.realtime.publish(channels.run(tenantId, runId), { type: 'run', status: 'cancelled' });
    }
  }

  async retryStep(runId: string, stepId: string): Promise<void> {
    const tenantId = requireTenantId();
    const jobs: StepJob[] = [];
    await this.db.scoped.$transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (run === null) throw notFound('Run');
      const step = await tx.stepRun.findFirst({ where: { id: stepId, runId } });
      if (step === null) throw notFound('Step');
      if (step.status !== 'failed') throw unprocessable('not_failed', 'Only failed steps can be retried');
      if (run.status === 'cancelled') throw unprocessable('cancelled', 'A cancelled run cannot be retried');
      const ld = await this.definitionFor(run);
      const node = ld.graph.nodes.get(step.nodeId);
      const extra = node === undefined ? 1 : retryPolicyFor(node).maxAttempts;
      await tx.stepRun.update({
        where: { id: stepId },
        data: {
          status: 'pending',
          maxAttempts: step.attempt + extra,
          error: undefined,
          outcome: null,
          finishedAt: null,
          scheduledFor: null,
          pendingSince: new Date(),
        },
      });
      const revived = await tx.stepRun.findMany({
        where: { runId, status: 'cancelled', error: { path: ['code'], equals: 'run_failed' } },
        select: { id: true },
      });
      await tx.stepRun.updateMany({
        where: { id: { in: revived.map((r) => r.id) } },
        data: { status: 'pending', finishedAt: null, pendingSince: new Date(), scheduledFor: null },
      });
      await tx.workflowRun.update({
        where: { id: runId },
        data: { status: 'running', error: undefined, finishedAt: null },
      });
      for (const id of [stepId, ...revived.map((r) => r.id)]) jobs.push({ stepRunId: id, tenantId });
    });
    await this.s.deps.queues.nudgeSteps(jobs);
  }

  async sweepExpiredLeases(): Promise<number> {
    const expired = await this.db.system.stepRun.findMany({
      where: { status: 'running', leaseExpiresAt: { lt: new Date() } },
      take: 500,
    });
    let count = 0;
    for (const step of expired) {
      const res = await runInContext(this.ctxFor(step.tenantId), () =>
        this.db.scoped.stepRun.updateMany({
          where: { id: step.id, status: 'running', leaseExpiresAt: { lt: new Date() } },
          data: {
            status: 'pending',
            leaseOwner: null,
            leaseExpiresAt: null,
            scheduledFor: null,
            pendingSince: new Date(),
            attempts: this.appendAttempt(step, {
              finishedAt: new Date().toISOString(),
              error: {
                message: `Lease expired (worker ${step.leaseOwner ?? '?'} stopped heartbeating)`,
                retryable: true,
                code: 'lease_expired',
              },
            }) as never,
          },
        }),
      );
      if (res.count > 0) {
        count += 1;
        this.s.deps.metrics.leaseExpired.inc();
        await this.s.deps.queues.nudgeSteps([{ stepRunId: step.id, tenantId: step.tenantId }]);
      }
    }
    if (count > 0) this.log.warn({ count }, 'recovered steps with expired leases');
    return count;
  }

  async fireDueTimers(): Promise<number> {
    const due = await this.db.system.stepRun.findMany({
      where: { status: 'waiting', scheduledFor: { lte: new Date() } },
      select: { id: true, tenantId: true },
      take: 500,
    });
    let fired = 0;
    for (const d of due)
      if (
        await this.handleTimer(d.id, d.tenantId).catch(
          (e: unknown) => this.log.error({ err: e }, 'timer failed') ?? false,
        )
      )
        fired += 1;
    return fired;
  }

  async renudgeLost(): Promise<number> {
    const threshold = new Date(Date.now() - this.cfg.lostNudgeAfterMs);
    const now = new Date();
    let lost = await this.db.system.stepRun.findMany({
      where: {
        status: 'pending',
        pendingSince: { lte: threshold },
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      select: { id: true, tenantId: true },
      take: 2000,
    });
    if (lost.length === 0) return 0;
    const byTenant = new Map<string, string[]>();
    for (const l of lost) byTenant.set(l.tenantId, [...(byTenant.get(l.tenantId) ?? []), l.id]);
    const parked = new Set<string>();
    for (const [tenantId, ids] of byTenant) {
      const flags = await this.semaphore.isParked(tenantId, ids).catch(() => ids.map(() => false));
      ids.forEach((id, i) => {
        if (flags[i] === true) parked.add(id);
      });
    }
    lost = lost.filter((l) => !parked.has(l.id));
    if (lost.length === 0) return 0;
    await this.db.system.stepRun.updateMany({
      where: { id: { in: lost.map((l) => l.id) }, status: 'pending' },
      data: { pendingSince: now },
    });
    await this.s.deps.queues.nudgeSteps(lost.map((l) => ({ stepRunId: l.id, tenantId: l.tenantId })));
    this.s.deps.metrics.lostNudges.inc(lost.length);
    return lost.length;
  }

  async unparkStalled(): Promise<number> {
    let nudged = 0;
    for (const tenantId of await this.semaphore.parkedTenants()) {
      const { settings } = await this.tenantInfo(tenantId);
      const limit = Math.max(1, settings.maxConcurrentSteps ?? this.cfg.tenantMaxConcurrentSteps);
      const ids = await this.semaphore.unparkFree(tenantId, limit);
      if (ids.length > 0) await this.s.deps.queues.nudgeSteps(ids.map((stepRunId) => ({ stepRunId, tenantId })));
      nudged += ids.length;
      await this.semaphore.forgetTenantIfEmpty(tenantId);
    }
    return nudged;
  }

  async expireAgentApprovals(): Promise<number> {
    const due = await this.db.system.approval.findMany({
      where: { status: 'pending', source: 'agent', expiresAt: { lt: new Date() } },
      take: 200,
    });
    let n = 0;
    for (const a of due) if (await runInContext(this.ctxFor(a.tenantId), () => this.s.approvals.expire(a))) n += 1;
    return n;
  }
}
