import { analyze, evaluate, hydrate, compileToSql, T } from '@ashamrai/expr';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  CausationEntry,
  DomainEvent,
  RunDetailDto,
  RunDto,
  StepRunDto,
  TriggerEntity,
  WorkflowDefinition,
} from '@bop/contracts';
import {
  entityType,
  sqlFieldResolver,
  traversedEdges,
  triggerEntity,
  triggerVars,
  validateDefinition,
} from '@bop/workflow-core';
import type { Logger } from 'pino';
import { requireContext, requireTenantId, runInContext } from '../context';
import { DomainError, notFound, unauthorized, validationFailed } from '../errors';
import type { StepRun, Workflow, WorkflowRun } from '../generated/prisma/client';
import { ConditionScanRepository } from '../raw/condition-scan.repository';
import { safeCompare } from '../util/safe';
import { decodeCursor, encodeCursor, iso, isoRequired } from '../util/json';
import { nextCronFire } from './definitions';
import type { Engine } from './engine';
import type { TriggerPayloadJson } from './env';
import type { EngineServices } from './types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaCache = new Map<string, ValidateFunction>();

function stepDto(s: StepRun): StepRunDto {
  return {
    id: s.id,
    nodeId: s.nodeId,
    nodeType: s.nodeType,
    iteration: s.iteration,
    status: s.status as StepRunDto['status'],
    attempt: s.attempt,
    maxAttempts: s.maxAttempts,
    input: s.input,
    output: s.output,
    outcome: s.outcome,
    error: (s.error ?? null) as StepRunDto['error'],
    attempts: (s.attempts ?? []) as unknown as StepRunDto['attempts'],
    idempotencyKey: s.idempotencyKey,
    scheduledFor: iso(s.scheduledFor),
    wait: (s.wait ?? null) as Record<string, unknown> | null,
    createdAt: isoRequired(s.createdAt),
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
  };
}

export class RunsService {
  private readonly scanRepo: ConditionScanRepository;
  private readonly log: Logger;

  constructor(
    private readonly s: EngineServices,
    private readonly engine: Engine,
  ) {
    this.scanRepo = new ConditionScanRepository(s.deps.db.system);
    this.log = s.deps.logger.child({ component: 'triggers' });
  }

  runDto(r: WorkflowRun, names?: Map<string, string>): RunDto {
    return {
      id: r.id,
      workflowId: r.workflowId,
      workflowName: names?.get(r.workflowId),
      version: r.version,
      status: r.status as RunDto['status'],
      triggerType: r.triggerType,
      dedupeKey: r.dedupeKey,
      isTest: r.isTest,
      startedAt: isoRequired(r.startedAt),
      finishedAt: iso(r.finishedAt),
      durationMs: r.finishedAt === null ? null : r.finishedAt.getTime() - r.startedAt.getTime(),
      error: (r.error ?? null) as RunDto['error'],
      causation: (r.causation ?? []) as unknown as RunDto['causation'],
    };
  }

  async list(q: {
    workflowId?: string;
    status?: string;
    limit: number;
    cursor?: string;
    includeTests?: boolean;
  }): Promise<{ items: RunDto[]; nextCursor: string | null }> {
    const c = decodeCursor(q.cursor);
    const rows = await this.s.deps.db.scoped.workflowRun.findMany({
      where: {
        ...(q.workflowId === undefined ? {} : { workflowId: q.workflowId }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.includeTests === true ? {} : { isTest: false }),
        ...(c === null
          ? {}
          : {
              OR: [
                { startedAt: { lt: new Date(String(c.v)) } },
                { startedAt: new Date(String(c.v)), id: { lt: c.id } },
              ],
            }),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const wfs = await this.s.deps.db.scoped.workflow.findMany({
      where: { id: { in: [...new Set(items.map((r) => r.workflowId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(wfs.map((w) => [w.id, w.name]));
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.runDto(r, names)),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ v: last.startedAt.toISOString(), id: last.id }) : null,
    };
  }

  async get(runId: string): Promise<RunDetailDto> {
    const run = await this.s.deps.db.scoped.workflowRun.findFirst({ where: { id: runId } });
    if (run === null) throw notFound('Run');
    const [steps, ld, wf] = await Promise.all([
      this.s.deps.db.scoped.stepRun.findMany({
        where: { runId },
        orderBy: [{ createdAt: 'asc' }, { iteration: 'asc' }],
      }),
      this.engine.definitionFor(run),
      this.s.deps.db.scoped.workflow.findFirst({ where: { id: run.workflowId }, select: { name: true } }),
    ]);
    const completed = new Map<string, string | null>();
    for (const st of steps) {
      if (st.iteration !== 0 && completed.has(st.nodeId)) continue;
      if (st.status === 'succeeded' || (st.status === 'failed' && st.outcome === 'error'))
        completed.set(st.nodeId, st.outcome ?? 'next');
      else if (st.status !== 'skipped' && st.status !== 'cancelled') completed.set(st.nodeId, null);
    }
    const payload = { ...(run.triggerPayload as Record<string, unknown>) };
    delete payload['trace'];
    return {
      ...this.runDto(run, new Map([[run.workflowId, wf?.name ?? '']])),
      triggerPayload: payload,
      context: (run.context ?? {}) as Record<string, unknown>,
      definition: ld.definition,
      steps: steps.map(stepDto),
      traversedEdges: traversedEdges(ld.graph, completed),
    };
  }

  private async loadRecord(entity: TriggerEntity, id: string): Promise<Record<string, unknown>> {
    const record = await this.s.records.load(entity, id);
    if (record === null) throw notFound(entity);
    return record;
  }

  async manualRun(workflowId: string, input: { recordId?: string; input?: Record<string, unknown> }): Promise<RunDto> {
    await this.engine.admit(requireTenantId(), 'paced');
    const wf = await this.s.workflows.row(workflowId);
    if (wf.activeVersion === null) throw new DomainError(422, 'not_published', 'Publish the workflow first');
    if (wf.status !== 'active') throw new DomainError(422, 'not_active', 'The workflow is not active');
    const ld = await this.s.workflows.loadVersion(workflowId, wf.activeVersion);
    const trigger = ld.definition.trigger;
    if (trigger.type !== 'manual') throw new DomainError(422, 'not_manual', 'This workflow is not started manually');
    for (const i of trigger.inputs ?? []) {
      if (i.required && (input.input?.[i.key] === undefined || input.input[i.key] === ''))
        throw validationFailed('Missing input', [{ path: `input.${i.key}`, message: 'required' }]);
    }
    const entity = trigger.entity;
    const payload: TriggerPayloadJson = { type: 'manual', firedAt: new Date().toISOString(), input: input.input ?? {} };
    if (entity !== undefined) {
      if (input.recordId === undefined)
        throw validationFailed('recordId is required', [{ path: 'recordId', message: 'required' }]);
      payload.entity = entity;
      payload.recordId = input.recordId;
      payload.record = await this.loadRecord(entity, input.recordId);
    }
    const ctx = requireContext();
    const { runId } = await this.engine.startRun({
      workflowId,
      version: wf.activeVersion,
      triggerType: 'manual',
      payload,
      dedupeKey: null,
      causation: ctx.causation,
      admission: 'admitted',
    });
    return this.runDto((await this.s.deps.db.scoped.workflowRun.findFirst({ where: { id: runId } })) as WorkflowRun);
  }

  async webhook(workflowId: string, secret: string, body: unknown): Promise<{ runId: string; created: boolean }> {
    const wf = await this.s.deps.db.system.workflow.findUnique({ where: { id: workflowId } });
    if (wf === null || !safeCompare(wf.webhookSecret, secret)) throw unauthorized('Unknown webhook');
    return runInContext({ tenantId: wf.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
      if (wf.status !== 'active' || wf.activeVersion === null || wf.triggerType !== 'webhook')
        throw new DomainError(409, 'not_active', 'Workflow is not active');
      await this.engine.admit(wf.tenantId, 'paced');
      const ld = await this.s.workflows.loadVersion(wf.id, wf.activeVersion);
      const trigger = ld.definition.trigger;
      if (trigger.type === 'webhook' && trigger.schema !== undefined) {
        const key = `${wf.id}:${wf.activeVersion}`;
        let validate = schemaCache.get(key);
        if (validate === undefined) {
          validate = ajv.compile(trigger.schema);
          schemaCache.set(key, validate);
        }
        if (!validate(body)) {
          throw validationFailed(
            'Payload does not match the webhook schema',
            (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' })),
          );
        }
      }
      const payload: TriggerPayloadJson = { type: 'webhook', firedAt: new Date().toISOString(), payload: body };
      return this.engine.startRun({
        workflowId: wf.id,
        version: wf.activeVersion,
        triggerType: 'webhook',
        payload,
        dedupeKey: null,
        causation: [],
        admission: 'admitted',
      });
    });
  }

  async testRun(
    workflowId: string,
    input: {
      definition?: unknown;
      recordId?: string;
      payload?: Record<string, unknown>;
      approvals: 'approve' | 'reject';
    },
  ): Promise<RunDto> {
    await this.s.workflows.row(workflowId);
    let definition = input.definition;
    if (definition === undefined) {
      const draft = await this.s.deps.db.scoped.workflowDraft.findFirst({ where: { workflowId } });
      if (draft === null) throw notFound('Draft');
      definition = draft.definition;
    }
    const check = validateDefinition(definition, await this.s.workflows.validationEnv());
    if (!check.ok || check.definition === null) {
      throw validationFailed(
        'Fix validation errors before a test run',
        check.issues
          .filter((i) => i.severity === 'error')
          .map((i) => ({ path: i.field ?? '', message: i.message, nodeId: i.nodeId ?? undefined })),
      );
    }
    const def = check.definition;
    const entity = triggerEntity(def.trigger);
    const payload: TriggerPayloadJson = { type: def.trigger.type, firedAt: new Date().toISOString() };
    (payload as unknown as Record<string, unknown>)['testApprovals'] = input.approvals;
    if (entity !== null) {
      let recordId = input.recordId;
      if (recordId === undefined) {
        const latest = await this.latestRecordId(entity);
        if (latest === null)
          throw validationFailed(`No ${entity} exists to test with`, [{ path: 'recordId', message: 'required' }]);
        recordId = latest;
      }
      payload.entity = entity;
      payload.recordId = recordId;
      payload.record = await this.loadRecord(entity, recordId);
      payload.event =
        def.trigger.type === 'record_event'
          ? { id: 'test', type: def.trigger.event, actorType: 'user', payload: {} }
          : null;
    }
    if (def.trigger.type === 'webhook') payload.payload = input.payload ?? {};
    if (def.trigger.type === 'manual') payload.input = input.payload ?? {};
    const { runId } = await this.engine.startRun({
      workflowId,
      version: 0,
      triggerType: def.trigger.type,
      payload,
      dedupeKey: null,
      causation: [],
      isTest: true,
      testDefinition: def,
    });
    return this.runDto((await this.s.deps.db.scoped.workflowRun.findFirst({ where: { id: runId } })) as WorkflowRun);
  }

  private async latestRecordId(entity: TriggerEntity): Promise<string | null> {
    const db = this.s.deps.db.scoped;
    const pick = { select: { id: true }, orderBy: { createdAt: 'desc' as const } };
    switch (entity) {
      case 'company':
        return (await db.company.findFirst({ where: { deletedAt: null }, ...pick }))?.id ?? null;
      case 'contact':
        return (await db.contact.findFirst({ where: { deletedAt: null }, ...pick }))?.id ?? null;
      case 'deal':
        return (await db.deal.findFirst({ where: { deletedAt: null }, ...pick }))?.id ?? null;
      case 'invoice':
        return (await db.invoice.findFirst(pick))?.id ?? null;
      case 'task':
        return (await db.task.findFirst(pick))?.id ?? null;
    }
  }

  async onEvent(event: DomainEvent): Promise<number> {
    const workflows = await this.s.deps.db.scoped.workflow.findMany({
      where: { status: 'active', triggerType: 'record_event', triggerKey: event.type },
    });
    let started = 0;
    for (const wf of workflows) {
      if (wf.activeVersion === null) continue;
      if (event.causation.some((c) => c.workflowId === wf.id)) {
        this.log.info({ workflowId: wf.id, eventId: event.id }, 'loop protection: event caused by this workflow');
        continue;
      }
      if (event.causation.length >= this.s.deps.config.engine.maxCausationDepth) {
        this.log.warn(
          { workflowId: wf.id, depth: event.causation.length },
          'loop protection: causation chain too deep',
        );
        continue;
      }
      try {
        if (await this.startFromEvent(wf, event)) started += 1;
      } catch (error) {
        this.log.error({ err: error, workflowId: wf.id }, 'failed to start run from event');
      }
    }
    return started;
  }

  private async startFromEvent(wf: Workflow, event: DomainEvent): Promise<boolean> {
    const ld = await this.s.workflows.loadVersion(wf.id, wf.activeVersion as number);
    const trigger = ld.definition.trigger;
    if (trigger.type !== 'record_event') return false;
    const record = await this.s.records.load(trigger.entity, event.entityId);
    if (record === null) return false;
    const payload: TriggerPayloadJson = {
      type: 'record_event',
      entity: trigger.entity,
      recordId: event.entityId,
      record,
      event: { id: event.id, type: event.type, actorType: event.actor.type, payload: event.payload },
      firedAt: event.occurredAt,
    };
    if (trigger.filter !== undefined && trigger.filter.trim() !== '') {
      const custom = await this.s.customFields.map();
      const vars = triggerVars(ld.definition, { custom });
      const env = {
        vars: {
          [trigger.entity]: hydrate(record, entityType(trigger.entity, custom)),
          trigger: hydrate(
            { type: 'record_event', event: event.type, firedAt: event.occurredAt, actorType: event.actor.type },
            vars['trigger'] ?? T.any,
          ),
        },
      };
      const parsed = analyze(trigger.filter, { vars });
      if (parsed.ast === null || evaluate(parsed.ast, env) !== true) return false;
    }
    const { created } = await this.engine.startRun({
      workflowId: wf.id,
      version: wf.activeVersion as number,
      triggerType: 'record_event',
      payload,
      dedupeKey: `event:${event.id}`,
      causation: event.causation as CausationEntry[],
    });
    return created;
  }

  async fireSchedules(now: Date): Promise<number> {
    const due = await this.s.deps.db.system.workflow.findMany({
      where: { status: 'active', triggerType: 'schedule', nextFireAt: { lte: now } },
      take: 200,
    });
    let fired = 0;
    for (const wf of due) {
      await runInContext({ tenantId: wf.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
        if (wf.activeVersion === null || wf.nextFireAt === null) return;
        const ld = await this.s.workflows.loadVersion(wf.id, wf.activeVersion);
        const trigger = ld.definition.trigger;
        if (trigger.type !== 'schedule') return;
        const info = await this.engine.tenantInfo(wf.tenantId);
        const tz = trigger.timezone ?? info.settings.timezone ?? 'UTC';
        const firedAt = wf.nextFireAt;
        const payload: TriggerPayloadJson = { type: 'schedule', firedAt: firedAt.toISOString() };
        const { created } = await this.engine.startRun({
          workflowId: wf.id,
          version: wf.activeVersion,
          triggerType: 'schedule',
          payload,
          dedupeKey: `cron:${firedAt.toISOString()}`,
          causation: [],
        });
        await this.s.deps.db.scoped.workflow.update({
          where: { id: wf.id },
          data: { nextFireAt: nextCronFire(trigger.cron, tz, now) },
        });
        if (created) fired += 1;
      });
    }
    return fired;
  }

  async scanConditions(now: Date, force = false): Promise<number> {
    const interval = this.s.deps.config.engine.scanIntervalMs;
    const workflows = await this.s.deps.db.system.workflow.findMany({
      where: {
        status: 'active',
        triggerType: 'record_condition',
        ...(force
          ? {}
          : { OR: [{ lastScanAt: null }, { lastScanAt: { lte: new Date(now.getTime() - interval + 250) } }] }),
      },
      take: 200,
    });
    let started = 0;
    for (const wf of workflows) {
      await runInContext({ tenantId: wf.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
        try {
          started += await this.scanOne(wf, now);
        } catch (error) {
          this.log.error({ err: error, workflowId: wf.id }, 'condition scan failed');
        } finally {
          await this.s.deps.db.scoped.workflow.update({ where: { id: wf.id }, data: { lastScanAt: now } });
        }
      });
    }
    return started;
  }

  private async scanOne(wf: Workflow, now: Date): Promise<number> {
    if (wf.activeVersion === null) return 0;
    const ld = await this.s.workflows.loadVersion(wf.id, wf.activeVersion);
    const trigger = ld.definition.trigger;
    if (trigger.type !== 'record_condition') return 0;
    const custom = await this.s.customFields.map();
    const vars = triggerVars(ld.definition, { custom });
    const parsed = analyze(trigger.condition, { vars });
    if (parsed.ast === null) return 0;
    const compiled = compileToSql(parsed.ast, { resolveField: sqlFieldResolver(trigger.entity, custom), now });
    if (!compiled.ok) return 0;
    const ids = await this.scanRepo.matchingIds(requireTenantId(), wf.id, trigger.entity, compiled, 500);
    let started = 0;
    const dedupeAst =
      trigger.dedupe !== undefined && trigger.dedupe.trim() !== '' ? analyze(trigger.dedupe, { vars }).ast : null;
    for (const id of ids) {
      const record = await this.s.records.load(trigger.entity, id);
      if (record === null) continue;
      const hydrated = hydrate(record, entityType(trigger.entity, custom));
      const dedupeValue =
        dedupeAst === null ? id : evaluate(dedupeAst, { vars: { [trigger.entity]: hydrated }, now: () => now });
      const payload: TriggerPayloadJson = {
        type: 'record_condition',
        entity: trigger.entity,
        recordId: id,
        record,
        firedAt: now.toISOString(),
      };
      const { created } = await this.engine.startRun({
        workflowId: wf.id,
        version: wf.activeVersion,
        triggerType: 'record_condition',
        payload,
        dedupeKey: String(dedupeValue),
        causation: [],
      });
      if (created) started += 1;
    }
    return started;
  }

  async taskReminders(now: Date): Promise<number> {
    const soon = new Date(now.getTime() + 60 * 60_000);
    const due = await this.s.deps.db.system.task.findMany({
      where: {
        status: { in: ['open', 'in_progress'] },
        remindedAt: null,
        assigneeId: { not: null },
        dueAt: { lte: soon },
      },
      take: 200,
    });
    for (const t of due) {
      await runInContext({ tenantId: t.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
        await this.s.deps.db.scoped.task.updateMany({
          where: { id: t.id, remindedAt: null },
          data: { remindedAt: now },
        });
        await this.s.notifications.notify(
          [t.assigneeId as string],
          'task.reminder',
          { taskId: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null },
          `task-reminder:${t.id}:${t.dueAt?.toISOString() ?? ''}`,
        );
      });
    }
    return due.length;
  }
}

export type { WorkflowDefinition };
