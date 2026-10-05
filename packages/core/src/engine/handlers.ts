import { Duration, Money, analyze, type EvalEnv, type TypeContext } from '@ashamrai/expr';
import type { DomainEvent, TriggerEntity, UserSummary, WorkflowNode } from '@bop/contracts';
import { classifyHttpStatus, recordEntityOf, triggerEntity, UPDATABLE_FIELDS } from '@bop/workflow-core';
import type { StepRun, Task, WorkflowRun } from '../generated/prisma/client';
import { isUniqueViolation } from '../errors';
import { requireContext } from '../context';
import { renderHtmlTemplate } from '../services/emails';
import { escapeHtml } from '../services/invoices';
import { FakeAiProvider } from './ai';
import type { LoadedDefinition } from './definitions';
import { StepError } from './errors';
import type { EngineServices } from './types';

export type HandlerResult =
  | { kind: 'done'; outcome: string; output: unknown }
  | { kind: 'wait'; until: Date | null; waitKey: string | null; wait: Record<string, unknown> }
  | { kind: 'loop'; items: unknown[]; concurrency: number };

export interface HandlerContext {
  s: EngineServices;
  run: WorkflowRun;
  step: StepRun;
  node: WorkflowNode;
  loaded: LoadedDefinition;
  input: Record<string, unknown>;
  env: EvalEnv;
  typeCtx: TypeContext;
  idempotencyKey: string;
  signal: AbortSignal;
  isTest: boolean;
  testApprovals: 'approve' | 'reject';
}

type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

const done = (output: unknown, outcome = 'next'): HandlerResult => ({ kind: 'done', outcome, output });

function asPlain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? (value as Record<string, unknown>)
    : null;
}

export function recipientsOf(value: unknown): { emails: string[]; userIds: string[] } {
  const emails: string[] = [];
  const userIds: string[] = [];
  const visit = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === 'string') {
      if (v.includes('@')) emails.push(v.trim());
      else if (/^[0-9a-f-]{36}$/i.test(v)) userIds.push(v);
      return;
    }
    const obj = asPlain(v);
    if (obj !== null) {
      if (typeof obj['id'] === 'string') userIds.push(obj['id']);
      if (typeof obj['email'] === 'string') emails.push(obj['email']);
    }
  };
  visit(value);
  return { emails: [...new Set(emails)], userIds: [...new Set(userIds)] };
}

function recordRef(ctx: HandlerContext, field: string): { entity: TriggerEntity; id: string } | null {
  const value = asPlain(ctx.input[field]);
  if (value === null || typeof value['id'] !== 'string') return null;
  const src = ctx.node.config[field];
  if (typeof src !== 'string') return null;
  const entity = recordEntityOf(analyze(src, ctx.typeCtx).type);
  if (entity === null) throw new StepError(`'${field}' is not a record`, false, 'invalid_input');
  return { entity, id: value['id'] };
}

function centsOf(value: unknown): number {
  if (value instanceof Money) return value.cents;
  if (typeof value === 'number') return Math.round(value);
  throw new StepError('Amount must be money or a number of minor units', false, 'invalid_input');
}

function msOf(value: unknown): number | null {
  if (value instanceof Duration) return value.ms;
  if (typeof value === 'number') return value;
  return null;
}

const condition: Handler = async (ctx) => {
  const result = ctx.input['expr'] === true;
  return done({ result }, result ? 'true' : 'false');
};

const switchNode: Handler = async (ctx) => {
  const cases = (ctx.input['cases'] ?? []) as Array<{ name: string; when: boolean }>;
  const hit = cases.find((c) => c.when);
  return done({ case: hit?.name ?? 'default' }, hit === undefined ? 'default' : `case:${hit.name}`);
};

const createTask: Handler = async (ctx) => {
  const assignees = recipientsOf(ctx.input['assignee']).userIds;
  const related = recordRef(ctx, 'relatedTo');
  const dueAt = ctx.input['dueAt'] instanceof Date ? (ctx.input['dueAt'] as Date).toISOString() : null;
  const input = {
    title: String(ctx.input['title'] ?? '').slice(0, 300) || 'Task',
    description:
      typeof ctx.input['description'] === 'string' && ctx.input['description'] !== ''
        ? String(ctx.input['description'])
        : null,
    assigneeId: assignees[0] ?? null,
    dueAt,
    priority:
      typeof ctx.input['priority'] === 'number'
        ? Math.min(4, Math.max(1, Math.round(ctx.input['priority'] as number)))
        : 2,
    relatedType: related?.entity ?? null,
    relatedId: related?.id ?? null,
  };
  if (ctx.isTest) return done({ dryRun: true, task: input });
  if (input.assigneeId !== null && (ctx.env.host?.user?.(input.assigneeId) ?? null) === null) {
    throw new StepError('Assignee is not a member of the workspace', false, 'invalid_input');
  }
  let row: Task;
  try {
    row = await ctx.s.deps.db.scoped.$transaction((tx) => ctx.s.tasks.createInTx(tx, input, ctx.idempotencyKey));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await ctx.s.deps.db.scoped.task.findFirst({ where: { idempotencyKey: ctx.idempotencyKey } });
    if (existing === null) throw error;
    row = existing;
  }
  const users = new Map<string, UserSummary>();
  const assignee = row.assigneeId === null ? null : (ctx.env.host?.user?.(row.assigneeId) ?? null);
  if (assignee !== null) users.set(assignee.id, assignee);
  return done(ctx.s.records.taskJson(row, users));
};

const updateRecord: Handler = async (ctx) => {
  const ref = recordRef(ctx, 'record');
  if (ref === null) throw new StepError('Record is empty', false, 'invalid_input');
  const fields = (ctx.input['fields'] ?? {}) as Record<string, unknown>;
  const allowed = UPDATABLE_FIELDS[ref.entity];
  const patch: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  let stageName: string | null = null;
  for (const [key, raw] of Object.entries(fields)) {
    const value = raw instanceof Date ? raw.toISOString() : raw instanceof Money ? raw.cents : raw;
    if (key.startsWith('custom.')) custom[key.slice(7)] = value;
    else if (ref.entity === 'deal' && key === 'stage') stageName = value === null ? null : String(value);
    else if (key in allowed) patch[key] = key === 'amountCents' ? centsOf(raw) : value;
    else throw new StepError(`Field '${key}' cannot be updated`, false, 'invalid_input');
  }
  if (Object.keys(custom).length > 0) patch['custom'] = custom;
  const changed = [...Object.keys(patch), ...(stageName === null ? [] : ['stage'])];
  if (ctx.isTest)
    return done({
      dryRun: true,
      id: ref.id,
      entity: ref.entity,
      changed,
      patch: { ...patch, ...(stageName === null ? {} : { stage: stageName }) },
    });
  const previous = await ctx.s.effects.lookup(ctx.idempotencyKey);
  if (previous !== undefined) return done(previous);
  switch (ref.entity) {
    case 'company':
      await ctx.s.companies.update(ref.id, patch);
      break;
    case 'contact':
      await ctx.s.contacts.update(ref.id, patch);
      break;
    case 'deal': {
      if (Object.keys(patch).length > 0) await ctx.s.deals.update(ref.id, patch);
      if (stageName !== null) {
        const deal = await ctx.s.deals.get(ref.id);
        const pipeline = (await ctx.s.deals.pipelines()).find((p) => p.id === deal.pipelineId);
        const stage = pipeline?.stages.find(
          (s) => s.name.toLowerCase() === stageName?.toLowerCase() || s.id === stageName,
        );
        if (stage === undefined) throw new StepError(`Unknown stage '${stageName}'`, false, 'invalid_input');
        if (stage.id !== deal.stageId)
          await ctx.s.deals.move(ref.id, {
            stageId: stage.id,
            lostReason: stage.kind === 'lost' ? 'Updated by workflow' : null,
          });
      }
      break;
    }
    case 'invoice':
      await ctx.s.invoices.update(ref.id, patch);
      break;
    case 'task':
      await ctx.s.tasks.update(ref.id, patch);
      break;
  }
  const output = { id: ref.id, entity: ref.entity, changed };
  await ctx.s.effects.record(ctx.idempotencyKey, 'update_record', output);
  return done(output);
};

const addNote: Handler = async (ctx) => {
  const ref = recordRef(ctx, 'subject');
  if (ref === null) throw new StepError('Record is empty', false, 'invalid_input');
  const body = String(ctx.input['body'] ?? '');
  if (ctx.isTest) return done({ dryRun: true, subject: ref, body });
  const { result } = await ctx.s.effects.once(ctx.idempotencyKey, 'add_note', async (tx) => {
    const ec = requireContext();
    const a = await tx.activity.create({
      data: {
        tenantId: ec.tenantId,
        subjectType: ref.entity,
        subjectId: ref.id,
        kind: 'note',
        actorType: 'workflow',
        actorId: ctx.run.id,
        data: { body, workflowId: ctx.run.workflowId, runId: ctx.run.id } as never,
        sourceKey: ctx.idempotencyKey,
      },
    });
    return { id: a.id };
  });
  return done(result);
};

const notify: Handler = async (ctx) => {
  const { userIds } = recipientsOf(ctx.input['to']);
  const message = String(ctx.input['message'] ?? '');
  if (ctx.isTest) return done({ dryRun: true, notified: userIds, message });
  const notified = await ctx.s.notifications.notify(
    userIds,
    'workflow.notify',
    {
      message,
      workflowId: ctx.run.workflowId,
      runId: ctx.run.id,
      ...(ctx.run.triggerPayload as { entity?: string; recordId?: string }),
    },
    ctx.idempotencyKey,
  );
  return done({ notified: userIds, created: notified.length });
};

const sendEmail: Handler = async (ctx) => {
  const { emails } = recipientsOf(ctx.input['to']);
  if (emails.length === 0)
    throw new StepError('No email recipient (the "to" expression evaluated to nothing)', false, 'no_recipient');
  let subject = typeof ctx.input['subject'] === 'string' ? (ctx.input['subject'] as string) : '';
  let html =
    typeof ctx.input['body'] === 'string'
      ? `<div>${escapeHtml(ctx.input['body'] as string).replace(/\n/g, '<br>')}</div>`
      : '';
  const templateKey = ctx.input['template'];
  if (typeof templateKey === 'string' && templateKey !== '') {
    const template = await ctx.s.deps.db.scoped.emailTemplate.findFirst({ where: { key: templateKey } });
    if (template === null)
      throw new StepError(`Email template '${templateKey}' does not exist`, false, 'unknown_template');
    subject = renderHtmlTemplate(template.subject, ctx.env, false);
    html = renderHtmlTemplate(template.body, ctx.env, true);
  }
  const entity = triggerEntity(ctx.loaded.definition.trigger);
  const recordId = (ctx.run.triggerPayload as { recordId?: string }).recordId ?? null;
  const attachInvoice = ctx.input['attachInvoice'] === true && entity === 'invoice' ? recordId : null;
  if (ctx.isTest)
    return done({ dryRun: true, messageId: 'test-preview', to: emails, preview: { subject, html, attachInvoice } });
  const { result } = await ctx.s.effects.once(ctx.idempotencyKey, 'send_email', async (tx) => {
    const msg = await ctx.s.emails.enqueue(tx, {
      to: emails,
      subject,
      html,
      relatedType: entity,
      relatedId: recordId,
      attachInvoice,
      idempotencyKey: ctx.idempotencyKey,
    });
    return { messageId: msg.id, to: emails };
  });
  await ctx.s.emails.nudge();
  return done(result);
};

const createInvoice: Handler = async (ctx) => {
  const company = recordRef(ctx, 'company');
  if (company === null || company.entity !== 'company')
    throw new StepError('Company is required', false, 'invalid_input');
  const contact = recordRef(ctx, 'contact');
  const deal = recordRef(ctx, 'deal');
  const amount = centsOf(ctx.input['amount']);
  const currency = ctx.input['amount'] instanceof Money ? (ctx.input['amount'] as Money).currency : 'USD';
  const dueMs = msOf(ctx.input['dueIn']) ?? 14 * 86_400_000;
  const input = {
    companyId: company.id,
    contactId: contact?.entity === 'contact' ? contact.id : null,
    dealId: deal?.entity === 'deal' ? deal.id : null,
    currency,
    issueDate: new Date().toISOString(),
    dueDate: new Date(Date.now() + dueMs).toISOString(),
    notes: `Created by workflow ${ctx.loaded.definition.name}`,
    lines: [
      {
        description: String(ctx.input['description'] ?? 'Services').slice(0, 500),
        quantity: 1,
        unitPriceCents: amount,
        taxRate: 0,
      },
    ],
  };
  if (ctx.isTest) return done({ dryRun: true, invoice: input });
  const previous = (await ctx.s.effects.lookup(ctx.idempotencyKey)) as { invoiceId?: string } | undefined;
  if (previous?.invoiceId !== undefined) return done(await ctx.s.records.load('invoice', previous.invoiceId, false));
  const invoice = await ctx.s.invoices.create(input, ctx.idempotencyKey);
  await ctx.s.effects.record(ctx.idempotencyKey, 'create_invoice', { invoiceId: invoice.id });
  return done(await ctx.s.records.load('invoice', invoice.id, false));
};

const httpRequest: Handler = async (ctx) => {
  const method = String(ctx.input['method'] ?? 'POST').toUpperCase();
  const url = String(ctx.input['url'] ?? '');
  if (!/^https?:\/\//.test(url)) throw new StepError('URL must start with http:// or https://', false, 'invalid_input');
  const headers: Record<string, string> = { 'idempotency-key': ctx.idempotencyKey, 'user-agent': 'bop-workflow/1.0' };
  for (const [k, v] of Object.entries((ctx.input['headers'] ?? {}) as Record<string, string>))
    headers[k.toLowerCase()] = String(v);
  const body =
    typeof ctx.input['body'] === 'string' && ctx.input['body'] !== '' && method !== 'GET'
      ? (ctx.input['body'] as string)
      : undefined;
  if (body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  if (ctx.isTest)
    return done({
      dryRun: true,
      status: 0,
      body: null,
      request: {
        method,
        url: '[redacted in stored input]',
        headers: Object.keys(headers),
        bodyLength: body?.length ?? 0,
      },
    });
  const previous = await ctx.s.effects.lookup(ctx.idempotencyKey);
  if (previous !== undefined) return done(previous);
  const timeout = AbortSignal.timeout(ctx.node.timeoutMs ?? ctx.s.deps.config.engine.httpTimeoutMs);
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.any([ctx.signal, timeout]) });
  const text = (await res.text()).slice(0, 64 * 1024);
  let parsed: unknown;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const cls = classifyHttpStatus(res.status);
    throw new StepError(`HTTP ${res.status} from ${new URL(url).host}`, cls === 'retryable', `http_${res.status}`);
  }
  const output = { status: res.status, body: parsed };
  await ctx.s.effects.record(ctx.idempotencyKey, 'http_request', output);
  return done(output);
};

const waitDuration: Handler = async (ctx) => {
  const ms = msOf(ctx.input['duration']);
  if (ms === null || ms < 0) throw new StepError('Duration must be a positive duration', false, 'invalid_input');
  if (ctx.isTest || ms === 0) return done({ resumedAt: new Date().toISOString(), skipped: ctx.isTest });
  return { kind: 'wait', until: new Date(Date.now() + ms), waitKey: null, wait: { kind: 'timer', ms } };
};

const waitUntil: Handler = async (ctx) => {
  const until = ctx.input['until'];
  if (!(until instanceof Date)) {
    if (until === null) return done({ resumedAt: new Date().toISOString(), skipped: true });
    throw new StepError('until must be a date', false, 'invalid_input');
  }
  if (ctx.isTest || until.getTime() <= Date.now())
    return done({ resumedAt: new Date().toISOString(), skipped: ctx.isTest });
  return { kind: 'wait', until, waitKey: null, wait: { kind: 'timer', until: until.toISOString() } };
};

export function eventWaitKey(entity: string, id: string, event: string): string {
  return `event:${entity}:${id}:${event}`;
}

const waitForEvent: Handler = async (ctx) => {
  const entity = String(ctx.input['entity'] ?? '');
  const id = String(ctx.input['id'] ?? '');
  const event = String(ctx.input['event'] ?? '');
  const timeoutMs = msOf(ctx.input['timeout']);
  if (ctx.isTest) return done({ event: null, payload: null, skipped: true }, 'timeout');
  const already = await ctx.s.deps.db.scoped.outbox.findFirst({
    where: { type: event, createdAt: { gte: ctx.run.startedAt }, payload: { path: ['entityId'], equals: id } },
    orderBy: { createdAt: 'asc' },
  });
  if (already !== null) {
    const e = already.payload as unknown as DomainEvent;
    return done({ event: e.type, payload: e.payload });
  }
  const until = timeoutMs === null ? null : new Date(Date.now() + timeoutMs);
  return {
    kind: 'wait',
    until,
    waitKey: eventWaitKey(entity, id, event),
    wait: { kind: 'event', entity, id, event, expiresAt: until?.toISOString() ?? null },
  };
};

const approval: Handler = async (ctx) => {
  const { userIds } = recipientsOf(ctx.input['assignees']);
  const title = String(ctx.input['title'] ?? 'Approval required');
  const timeoutMs = msOf(ctx.input['timeout']);
  if (ctx.isTest) {
    const decision = ctx.testApprovals === 'approve' ? 'approved' : 'rejected';
    return done({ decision, decidedBy: null, comment: 'auto-decided in test run', assignees: userIds }, decision);
  }
  const expiresAt = timeoutMs === null ? null : new Date(Date.now() + timeoutMs);
  const payload = ctx.run.triggerPayload as { entity?: string; recordId?: string; record?: Record<string, unknown> };
  const { result } = await ctx.s.effects.once(ctx.idempotencyKey, 'approval', async (tx) => {
    const a = await ctx.s.approvals.createInTx(tx, {
      source: 'workflow',
      sourceRef: { runId: ctx.run.id, stepRunId: ctx.step.id, workflowId: ctx.run.workflowId, nodeId: ctx.node.id },
      title,
      details: {
        description: typeof ctx.input['details'] === 'string' ? ctx.input['details'] : null,
        workflow: ctx.loaded.definition.name,
        record:
          payload.entity === undefined
            ? null
            : {
                type: payload.entity,
                id: payload.recordId,
                title: payload.record?.['number'] ?? payload.record?.['title'] ?? payload.record?.['name'] ?? null,
              },
        amountCents: payload.record?.['totalCents'] ?? payload.record?.['amountCents'] ?? null,
        currency: payload.record?.['currency'] ?? null,
      },
      assigneeIds: userIds,
      expiresAt,
    });
    return { approvalId: a.id };
  });
  const approvalId = (result as { approvalId: string }).approvalId;
  const created = await ctx.s.deps.db.scoped.approval.findFirst({ where: { id: approvalId } });
  if (created !== null && created.status === 'pending') await ctx.s.approvals.afterCreate(created);
  if (created !== null && created.status !== 'pending') {
    const outcome = created.status === 'approved' ? 'approved' : created.status === 'rejected' ? 'rejected' : 'timeout';
    return done({ decision: created.status, decidedBy: created.decidedBy, comment: created.comment }, outcome);
  }
  return {
    kind: 'wait',
    until: expiresAt,
    waitKey: `approval:${approvalId}`,
    wait: { kind: 'approval', approvalId, assigneeIds: userIds, expiresAt: expiresAt?.toISOString() ?? null },
  };
};

const forEach: Handler = async (ctx) => {
  const items = ctx.input['items'];
  if (!Array.isArray(items)) throw new StepError('items must be a list', false, 'invalid_input');
  if (items.length > 1000) throw new StepError('for_each supports at most 1000 items', false, 'limit');
  const concurrency =
    typeof ctx.input['concurrency'] === 'number'
      ? Math.min(10, Math.max(1, Math.round(ctx.input['concurrency'] as number)))
      : 2;
  return { kind: 'loop', items, concurrency };
};

const TEST_RUN_AI = new FakeAiProvider();

const aiStep: Handler = async (ctx) => {
  const task = String(ctx.input['task'] ?? 'classify');
  const text = String(ctx.input['input'] ?? '').slice(0, 20_000);
  const tenantId = requireContext().tenantId;
  if (!ctx.s.deps.flags.isEnabled('workflow-ai-step', tenantId))
    throw new StepError('ai_step is disabled by a feature flag', false, 'feature_disabled');
  const previous = await ctx.s.effects.lookup(ctx.idempotencyKey);
  if (previous !== undefined) return done(previous);
  const meta = {
    idempotencyKey: ctx.idempotencyKey,
    tenantId,
    workflowId: ctx.run.workflowId,
    runId: ctx.run.id,
    nodeId: ctx.node.id,
    timeoutMs: ctx.node.timeoutMs ?? ctx.s.deps.config.engine.httpTimeoutMs,
  };
  const dryRun = ctx.isTest && ctx.s.ai.name === 'operator';
  const provider = dryRun ? TEST_RUN_AI : ctx.s.ai;
  const result =
    task === 'summarize'
      ? await provider.summarize(text, ctx.signal, meta)
      : await provider.classify(
          text,
          ((ctx.input['labels'] ?? []) as string[]).filter((l) => typeof l === 'string'),
          ctx.signal,
          meta,
        );
  const output = { ...result, provider: provider.name, ...(dryRun ? { dryRun: true } : {}) };
  if (!ctx.isTest) await ctx.s.effects.record(ctx.idempotencyKey, 'ai_step', output);
  return done(output);
};

const end: Handler = async () => done({});

export const HANDLERS: Record<WorkflowNode['type'], Handler> = {
  condition,
  switch: switchNode,
  create_task: createTask,
  update_record: updateRecord,
  add_note: addNote,
  notify,
  create_invoice: createInvoice,
  send_email: sendEmail,
  http_request: httpRequest,
  wait_duration: waitDuration,
  wait_until: waitUntil,
  wait_for_event: waitForEvent,
  approval,
  for_each: forEach,
  ai_step: aiStep,
  end,
};
