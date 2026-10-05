import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type {
  ValidationIssue,
  WorkflowDefinition,
  WorkflowDetailDto,
  WorkflowDto,
  WorkflowStatus,
} from '@bop/contracts';
import {
  WORKFLOW_TEMPLATES,
  buildGraph,
  diffDefinitions,
  findTemplate,
  stableStringify,
  validateDefinition,
  type DefinitionDiff,
  type Graph,
  type ValidationEnv,
} from '@bop/workflow-core';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId } from '../context';
import { DomainError, notFound, validationFailed } from '../errors';
import { writeAudit } from '../events/outbox';
import type { Workflow } from '../generated/prisma/client';
import type { CustomFieldsService } from '../services/custom-fields';
import type { EmailsService } from '../services/emails';
import type { SecretsService } from '../services/accounts';
import { randomToken } from '../util/crypto';
import { iso, isoRequired } from '../util/json';

export interface LoadedDefinition {
  definition: WorkflowDefinition;
  graph: Graph;
}

const cache = new Map<string, LoadedDefinition>();

export function loaded(definition: WorkflowDefinition): LoadedDefinition {
  return { definition, graph: buildGraph(definition) };
}

export function checksum(definition: WorkflowDefinition): string {
  return createHash('sha256').update(stableStringify(definition)).digest('hex');
}

export function nextCronFire(cron: string, timezone: string, after: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
  return it.next().toDate();
}

function blankDefinition(name: string): WorkflowDefinition {
  return {
    name,
    trigger: { type: 'manual' },
    nodes: [{ id: 'end', type: 'end', config: {} }],
    edges: [{ from: '$trigger', to: 'end' }],
  };
}

export class WorkflowsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly customFields: CustomFieldsService,
    private readonly emails: EmailsService,
    private readonly secrets: SecretsService,
  ) {}

  webhookUrl(w: Pick<Workflow, 'id' | 'webhookSecret'>): string {
    return `${this.deps.config.publicApiUrl}/hooks/${w.id}/${w.webhookSecret}`;
  }

  dto(w: Workflow): WorkflowDto {
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      status: w.status as WorkflowStatus,
      activeVersion: w.activeVersion,
      triggerType: w.triggerType,
      triggerKey: w.triggerKey,
      templateKey: w.templateKey,
      webhookUrl: this.webhookUrl(w),
      createdAt: isoRequired(w.createdAt),
      updatedAt: isoRequired(w.updatedAt),
    };
  }

  async validationEnv(): Promise<ValidationEnv> {
    const [custom, emailTemplates, secrets] = await Promise.all([
      this.customFields.map(),
      this.emails.templateKeys(),
      this.secrets.names(),
    ]);
    return { custom, emailTemplates, secrets };
  }

  async validate(definition: unknown): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
    const result = validateDefinition(definition, await this.validationEnv());
    const issues = [...result.issues];
    if (result.definition !== null && result.definition.trigger.type === 'schedule') {
      try {
        nextCronFire(result.definition.trigger.cron, result.definition.trigger.timezone ?? 'UTC', new Date());
      } catch (error) {
        issues.push({
          nodeId: null,
          field: 'trigger.cron',
          code: 'invalid_cron',
          message: (error as Error).message,
          severity: 'error',
        });
      }
    }
    if (
      result.definition !== null &&
      result.definition.nodes.some((n) => n.type === 'ai_step') &&
      !this.deps.flags.isEnabled('workflow-ai-step', requireTenantId())
    ) {
      issues.push({
        nodeId: null,
        field: null,
        code: 'feature_disabled',
        message: 'The ai_step node is disabled by a feature flag for this workspace',
        severity: 'error',
      });
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }

  async list(): Promise<WorkflowDto[]> {
    const rows = await this.deps.db.scoped.workflow.findMany({
      where: { NOT: { status: 'archived' } },
      orderBy: { createdAt: 'desc' },
    });
    const stats = await this.deps.db.scoped.workflowRun.groupBy({
      by: ['workflowId', 'status'],
      where: { workflowId: { in: rows.map((r) => r.id) }, isTest: false },
      _count: true,
      _max: { startedAt: true },
    });
    return rows.map((r) => {
      const mine = stats.filter((s) => s.workflowId === r.id);
      const count = (st: string) => mine.filter((s) => s.status === st).reduce((a, s) => a + s._count, 0);
      const last = mine
        .map((s) => s._max.startedAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        ...this.dto(r),
        stats: {
          runs: mine.reduce((a, s) => a + s._count, 0),
          running: count('running') + count('waiting'),
          failed: count('failed'),
          lastRunAt: iso(last ?? null),
        },
      };
    });
  }

  async row(id: string): Promise<Workflow> {
    const w = await this.deps.db.scoped.workflow.findFirst({ where: { id } });
    if (w === null) throw notFound('Workflow');
    return w;
  }

  async get(id: string): Promise<WorkflowDetailDto> {
    const w = await this.row(id);
    const [draft, versions] = await Promise.all([
      this.deps.db.scoped.workflowDraft.findFirst({ where: { workflowId: id } }),
      this.deps.db.scoped.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { version: 'desc' } }),
    ]);
    const active = versions.find((v) => v.version === w.activeVersion);
    return {
      ...this.dto(w),
      draft:
        draft === null ? null : { definition: draft.definition as WorkflowDefinition, updatedAt: iso(draft.updatedAt) },
      active:
        active === undefined
          ? null
          : {
              version: active.version,
              definition: active.definition as WorkflowDefinition,
              publishedAt: isoRequired(active.publishedAt),
              checksum: active.checksum,
            },
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: isoRequired(v.publishedAt),
        publishedBy: v.publishedBy,
        checksum: v.checksum,
      })),
    };
  }

  templates() {
    return WORKFLOW_TEMPLATES;
  }

  async create(input: {
    name: string;
    description?: string;
    templateKey?: string;
    definition?: WorkflowDefinition;
  }): Promise<WorkflowDetailDto> {
    const ctx = requireContext();
    const template = input.templateKey === undefined ? undefined : findTemplate(input.templateKey);
    if (input.templateKey !== undefined && template === undefined)
      throw validationFailed('Unknown template', [{ path: 'templateKey', message: input.templateKey }]);
    const definition: WorkflowDefinition = {
      ...(input.definition ?? template?.definition ?? blankDefinition(input.name)),
      name: input.name,
    };
    const id = await this.deps.db.scoped.$transaction(async (tx) => {
      const w = await tx.workflow.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? template?.description ?? null,
          status: 'draft',
          webhookSecret: randomToken(18),
          templateKey: input.templateKey ?? null,
          createdBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        },
      });
      await tx.workflowDraft.create({
        data: {
          tenantId: ctx.tenantId,
          workflowId: w.id,
          definition: definition as never,
          updatedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
          updatedAt: new Date(),
        },
      });
      await writeAudit(tx, 'workflow.created', 'workflow', w.id, {
        name: input.name,
        templateKey: input.templateKey ?? null,
      });
      return w.id;
    });
    return this.get(id);
  }

  async update(
    id: string,
    input: { name?: string; description?: string | null; status?: 'active' | 'paused' | 'archived' },
  ): Promise<WorkflowDetailDto> {
    const w = await this.row(id);
    if (input.status === 'active' && w.activeVersion === null)
      throw new DomainError(422, 'not_published', 'Publish the workflow before activating it');
    await this.deps.db.scoped.workflow.update({
      where: { id },
      data: { name: input.name, description: input.description, status: input.status },
    });
    await writeAudit(this.deps.db.scoped, 'workflow.updated', 'workflow', id, input as Record<string, unknown>);
    return this.get(id);
  }

  async saveDraft(id: string, definition: unknown): Promise<{ updatedAt: string; issues: ValidationIssue[] }> {
    const w = await this.row(id);
    const ctx = requireContext();
    const result = await this.validate(definition);
    const now = new Date();
    await this.deps.db.scoped.workflowDraft.upsert({
      where: { workflowId: id },
      create: {
        tenantId: w.tenantId,
        workflowId: id,
        definition: definition as never,
        updatedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        updatedAt: now,
      },
      update: {
        definition: definition as never,
        updatedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        updatedAt: now,
      },
    });
    return { updatedAt: now.toISOString(), issues: result.issues };
  }

  async diff(id: string): Promise<DefinitionDiff> {
    const detail = await this.get(id);
    if (detail.draft === null) throw notFound('Draft');
    return diffDefinitions(detail.active?.definition ?? null, detail.draft.definition);
  }

  async publish(id: string): Promise<WorkflowDetailDto> {
    const ctx = requireContext();
    const w = await this.row(id);
    const draft = await this.deps.db.scoped.workflowDraft.findFirst({ where: { workflowId: id } });
    if (draft === null) throw notFound('Draft');
    const result = await this.validate(draft.definition);
    if (!result.ok) {
      throw validationFailed(
        'The workflow has validation errors',
        result.issues
          .filter((i) => i.severity === 'error')
          .map((i) => ({ path: i.field ?? '', message: i.message, nodeId: i.nodeId ?? undefined })),
      );
    }
    const definition = draft.definition as WorkflowDefinition;
    const trigger = definition.trigger;
    const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: w.tenantId } });
    const tz =
      trigger.type === 'schedule'
        ? (trigger.timezone ?? ((tenant?.settings ?? {}) as { timezone?: string }).timezone ?? 'UTC')
        : 'UTC';
    await this.deps.db.scoped.$transaction(async (tx) => {
      const last = await tx.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { version: 'desc' } });
      const version = (last?.version ?? 0) + 1;
      await tx.workflowVersion.create({
        data: {
          tenantId: w.tenantId,
          workflowId: id,
          version,
          definition: definition as never,
          checksum: checksum(definition),
          publishedBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        },
      });
      await tx.workflow.update({
        where: { id },
        data: {
          activeVersion: version,
          status: w.status === 'paused' ? 'paused' : 'active',
          name: definition.name,
          triggerType: trigger.type,
          triggerKey:
            trigger.type === 'record_event'
              ? trigger.event
              : trigger.type === 'record_condition'
                ? trigger.entity
                : trigger.type === 'schedule'
                  ? trigger.cron
                  : null,
          nextFireAt: trigger.type === 'schedule' ? nextCronFire(trigger.cron, tz, new Date()) : null,
        },
      });
      await writeAudit(tx, 'workflow.published', 'workflow', id, { version, checksum: checksum(definition) });
    });
    return this.get(id);
  }

  async loadVersion(workflowId: string, version: number): Promise<LoadedDefinition> {
    const key = `${workflowId}:${version}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const row = await this.deps.db.system.workflowVersion.findUnique({
      where: { workflowId_version: { workflowId, version } },
    });
    if (row === null) throw notFound('Workflow version');
    const value = loaded(row.definition as WorkflowDefinition);
    cache.set(key, value);
    if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
    return value;
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.deps.db.scoped.workflow.update({ where: { id }, data: { status: 'archived' } });
  }
}
