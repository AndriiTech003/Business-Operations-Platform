import { z } from 'zod';
import type {
  ActivityDto,
  CompanyDto,
  ContactDto,
  DealDto,
  EmailMessageDto,
  InvoiceDto,
  Page,
  PipelineDto,
  SearchResult,
  TaskDto,
} from '@bop/contracts';
import { untrustedPaths } from '@bop/contracts';
import type { OpsApiClient } from './client';

export type Risk = 'read' | 'write_reversible' | 'external' | 'irreversible';

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  input: S;
  handler(api: OpsApiClient, args: z.infer<z.ZodObject<S>>): Promise<ToolOutput>;
}

export interface ToolOutput {
  result: unknown;
  untrusted?: string[];
  dryRun?: boolean;
  idempotencyKey?: string;
}

const id = z.uuid().describe('Record id (uuid)');
const writeControls = {
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .optional()
    .describe('Repeat the same key to make retries safe: the action is applied at most once'),
  dryRun: z.boolean().optional().describe('Return a preview of the change without applying it'),
};

const cursor = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe('nextCursor from the previous page of this tool; omit for the first page');
const PAGE_HINT = ' Results are paginated: when nextCursor is not null, call again with cursor=nextCursor.';

async function recent(api: OpsApiClient, path: string): Promise<ActivityDto[]> {
  const page = await api.get<Page<ActivityDto>>(path, { limit: 10 });
  return page.items;
}

function chips(filters: Array<[string, string, unknown]>): string | undefined {
  const list = filters.filter(([, , v]) => v !== undefined).map(([field, op, value]) => ({ field, op, value }));
  return list.length === 0 ? undefined : JSON.stringify(list);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function define<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export const TOOLS = [
  define({
    name: 'search_records',
    title: 'Search records',
    description:
      'Global full-text and fuzzy search across companies, contacts, deals, invoices and tasks. Returns hits grouped by type.',
    risk: 'read',
    input: {
      query: z.string().min(1).max(200),
      types: z.array(z.enum(['company', 'contact', 'deal', 'invoice', 'task'])).optional(),
    },
    async handler(api, args) {
      return {
        result: await api.get<SearchResult>('/v1/search', { q: args.query, types: args.types?.join(','), limit: 8 }),
      };
    },
  }),
  define({
    name: 'get_company',
    title: 'Get company',
    description: 'Company details with stats and the 10 most recent activities.',
    risk: 'read',
    input: { id },
    async handler(api, args) {
      const [company, activities] = await Promise.all([
        api.get<CompanyDto>(`/v1/companies/${args.id}`),
        recent(api, `/v1/companies/${args.id}/timeline`),
      ]);
      return { result: { company, activities } };
    },
  }),
  define({
    name: 'get_contact',
    title: 'Get contact',
    description:
      'Contact details with the 10 most recent activities. Fields filled by outside people are listed in `untrusted`.',
    risk: 'read',
    input: { id },
    async handler(api, args) {
      const [contact, activities] = await Promise.all([
        api.get<ContactDto>(`/v1/contacts/${args.id}`),
        recent(api, `/v1/contacts/${args.id}/timeline`),
      ]);
      return { result: { contact, activities } };
    },
  }),
  define({
    name: 'get_deal',
    title: 'Get deal',
    description: 'Deal with stage, amount, owner and the 10 most recent activities.',
    risk: 'read',
    input: { id },
    async handler(api, args) {
      const [deal, activities] = await Promise.all([
        api.get<DealDto>(`/v1/deals/${args.id}`),
        recent(api, `/v1/deals/${args.id}/timeline`),
      ]);
      return { result: { deal, activities } };
    },
  }),
  define({
    name: 'get_invoice',
    title: 'Get invoice',
    description: 'Invoice with lines, payments, balance and the 10 most recent activities.',
    risk: 'read',
    input: { id },
    async handler(api, args) {
      const [invoice, activities] = await Promise.all([
        api.get<InvoiceDto>(`/v1/invoices/${args.id}`),
        recent(api, `/v1/invoices/${args.id}/timeline`),
      ]);
      return {
        result: { invoice, activities },
        untrusted: invoice.notes !== null && invoice.createdByType === 'agent' ? ['invoice.notes'] : [],
      };
    },
  }),
  define({
    name: 'list_contacts',
    title: 'List contacts',
    description: `Filter contacts by status, owner, last contact date, tags and custom fields.${PAGE_HINT}`,
    risk: 'read',
    input: {
      status: z.enum(['lead', 'active', 'customer', 'churned']).optional(),
      ownerId: z.uuid().optional(),
      lastContactedBefore: z.iso.datetime({ offset: true }).optional(),
      tags: z.array(z.string()).max(10).optional(),
      custom: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Custom field equality filters, e.g. {"linkedin": "..."}'),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor,
    },
    async handler(api, args) {
      const filters: Array<[string, string, unknown]> = [
        ['status', 'eq', args.status],
        ['ownerId', 'eq', args.ownerId],
        ['lastContactedAt', 'lt', args.lastContactedBefore],
        ['tags', 'in', args.tags],
        ...Object.entries(args.custom ?? {}).map(([k, v]) => [`custom.${k}`, 'eq', v] as [string, string, unknown]),
      ];
      return {
        result: await api.get<Page<ContactDto>>('/v1/contacts', {
          filter: chips(filters),
          q: args.query,
          limit: args.limit,
          cursor: args.cursor,
        }),
      };
    },
  }),
  define({
    name: 'list_deals',
    title: 'List deals',
    description: `Filter deals by stage (id or name), owner, amount range (minor units) and how long they have been in their stage. Sorted by amount, largest first.${PAGE_HINT}`,
    risk: 'read',
    input: {
      stage: z.string().max(100).optional().describe('Stage id or name'),
      ownerId: z.uuid().optional(),
      amountMinCents: z.number().int().min(0).optional(),
      amountMaxCents: z.number().int().min(0).optional(),
      stageChangedBefore: z.iso.datetime({ offset: true }).optional(),
      open: z.boolean().optional().describe('Only deals that are not won or lost'),
      limit: z.number().int().min(1).max(100).default(25),
      cursor,
    },
    async handler(api, args) {
      let stageId: string | undefined;
      if (args.stage !== undefined) {
        const pipelines = await api.get<PipelineDto[]>('/v1/pipelines');
        stageId =
          pipelines
            .flatMap((p) => p.stages)
            .find((s) => s.id === args.stage || s.name.toLowerCase() === args.stage?.toLowerCase())?.id ?? args.stage;
      }
      const filters: Array<[string, string, unknown]> = [
        ['stageId', 'eq', stageId],
        ['ownerId', 'eq', args.ownerId],
        ['amountCents', 'gte', args.amountMinCents],
        ['amountCents', 'lte', args.amountMaxCents],
        ['stageChangedAt', 'lt', args.stageChangedBefore],
        ['closedAt', args.open === true ? 'empty' : 'not_empty', args.open === undefined ? undefined : null],
      ];
      return {
        result: await api.get<Page<DealDto>>('/v1/deals', {
          filter: chips(filters),
          limit: args.limit,
          sort: '-amountCents',
          cursor: args.cursor,
        }),
      };
    },
  }),
  define({
    name: 'list_invoices',
    title: 'List invoices',
    description: `Filter invoices by status, due date, days overdue and amount range (minor units). overdueDays=N returns unpaid invoices due more than N days ago. Sorted by due date, oldest first.${PAGE_HINT}`,
    risk: 'read',
    input: {
      status: z.enum(['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void']).optional(),
      dueBefore: z.iso.datetime({ offset: true }).optional(),
      overdueDays: z.number().int().min(0).max(3650).optional(),
      amountMinCents: z.number().int().min(0).optional(),
      amountMaxCents: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor,
    },
    async handler(api, args) {
      const filters: Array<[string, string, unknown]> = [
        [
          'status',
          args.overdueDays !== undefined && args.status === undefined ? 'in' : 'eq',
          args.overdueDays !== undefined && args.status === undefined
            ? ['sent', 'partially_paid', 'overdue']
            : args.status,
        ],
        ['dueDate', 'lt', args.overdueDays !== undefined ? daysAgo(args.overdueDays) : args.dueBefore],
        ['totalCents', 'gte', args.amountMinCents],
        ['totalCents', 'lte', args.amountMaxCents],
      ];
      return {
        result: await api.get<Page<InvoiceDto>>('/v1/invoices', {
          filter: chips(filters),
          limit: args.limit,
          sort: 'dueDate',
          cursor: args.cursor,
        }),
      };
    },
  }),
  define({
    name: 'get_report',
    title: 'Get report',
    description: 'Prebuilt reports only (no arbitrary SQL): pipeline, revenue, ar_aging, activity.',
    risk: 'read',
    input: {
      name: z.enum(['pipeline', 'revenue', 'ar_aging', 'activity']),
      params: z
        .object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          ownerId: z.uuid().optional(),
        })
        .optional(),
    },
    async handler(api, args) {
      const path = args.name === 'ar_aging' ? '/v1/reports/ar-aging' : `/v1/reports/${args.name}`;
      return {
        result: await api.get<unknown>(path, {
          from: args.params?.from,
          to: args.params?.to,
          ownerId: args.params?.ownerId,
        }),
      };
    },
  }),
  define({
    name: 'create_task',
    title: 'Create task',
    description: 'Create a task, optionally assigned and linked to a record.',
    risk: 'write_reversible',
    input: {
      title: z.string().min(1).max(300),
      description: z.string().max(10000).optional(),
      assigneeId: z.uuid().optional(),
      dueAt: z.iso.datetime({ offset: true }).optional(),
      priority: z.number().int().min(1).max(4).optional(),
      relatedType: z.enum(['company', 'contact', 'deal', 'invoice']).optional(),
      relatedId: z.uuid().optional(),
      ...writeControls,
    },
    async handler(api, args) {
      const { idempotencyKey, dryRun, ...body } = args;
      return {
        result: await api.request<TaskDto>('POST', '/v1/tasks', { body, idempotencyKey, dryRun }),
        dryRun: dryRun === true,
        idempotencyKey,
      };
    },
  }),
  define({
    name: 'add_note',
    title: 'Add note',
    description: 'Add a note (or call/meeting log) to the timeline of a record.',
    risk: 'write_reversible',
    input: {
      subject: z.object({ type: z.enum(['company', 'contact', 'deal', 'invoice']), id: z.uuid() }),
      body: z.string().min(1).max(20000),
      kind: z.enum(['note', 'call', 'meeting']).optional(),
      ...writeControls,
    },
    async handler(api, args) {
      const body = {
        subjectType: args.subject.type,
        subjectId: args.subject.id,
        body: args.body,
        kind: args.kind ?? 'note',
      };
      return {
        result: await api.request<ActivityDto>('POST', '/v1/notes', {
          body,
          idempotencyKey: args.idempotencyKey,
          dryRun: args.dryRun,
        }),
        dryRun: args.dryRun === true,
        idempotencyKey: args.idempotencyKey,
      };
    },
  }),
  define({
    name: 'update_deal',
    title: 'Update deal',
    description:
      'Change stage (id or name), amount, owner, title or custom fields of a deal. Moving to a lost stage requires lostReason.',
    risk: 'write_reversible',
    input: {
      id,
      patch: z.object({
        stage: z.string().max(100).optional(),
        amountCents: z.number().int().min(0).optional(),
        ownerId: z.uuid().nullable().optional(),
        title: z.string().min(1).max(200).optional(),
        expectedCloseAt: z.iso.datetime({ offset: true }).nullable().optional(),
        lostReason: z.string().max(500).optional(),
        custom: z.record(z.string(), z.unknown()).optional(),
      }),
      ...writeControls,
    },
    async handler(api, args) {
      const deal = await api.get<DealDto>(`/v1/deals/${args.id}`);
      const { stage, lostReason, ...fields } = args.patch;
      let stageId: string | undefined;
      if (stage !== undefined) {
        const pipelines = await api.get<PipelineDto[]>('/v1/pipelines');
        const found = pipelines
          .find((p) => p.id === deal.pipelineId)
          ?.stages.find((s) => s.id === stage || s.name.toLowerCase() === stage.toLowerCase());
        if (found === undefined) throw new Error(`Unknown stage '${stage}'`);
        stageId = found.id;
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, v] of Object.entries(fields)) {
        const before = (deal as unknown as Record<string, unknown>)[k];
        if (k === 'custom') changes[k] = { from: deal.custom, to: { ...deal.custom, ...(v as object) } };
        else if (JSON.stringify(before) !== JSON.stringify(v)) changes[k] = { from: before, to: v };
      }
      if (stageId !== undefined && stageId !== deal.stageId) changes['stageId'] = { from: deal.stageId, to: stageId };
      if (args.dryRun === true) return { result: { dryRun: true, deal, changes }, dryRun: true };
      let updated: DealDto = deal;
      if (Object.keys(fields).length > 0) {
        updated = await api.request<DealDto>('PATCH', `/v1/deals/${args.id}`, {
          body: { ...fields, ...(lostReason === undefined ? {} : { lostReason }) },
          idempotencyKey: args.idempotencyKey === undefined ? undefined : `${args.idempotencyKey}:fields`,
        });
      }
      if (stageId !== undefined && stageId !== deal.stageId) {
        updated = await api.request<DealDto>('PATCH', `/v1/deals/${args.id}/move`, {
          body: { stageId, lostReason: lostReason ?? null },
          idempotencyKey: args.idempotencyKey === undefined ? undefined : `${args.idempotencyKey}:move`,
        });
      }
      return { result: { deal: updated, changes }, idempotencyKey: args.idempotencyKey };
    },
  }),
  define({
    name: 'draft_email',
    title: 'Draft email',
    description: 'Create an email draft linked to a record. Nothing is sent until send_email is called.',
    risk: 'write_reversible',
    input: {
      to: z.array(z.email()).min(1).max(20),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(50000),
      relatedTo: z.object({ type: z.enum(['company', 'contact', 'deal', 'invoice']), id: z.uuid() }).optional(),
      ...writeControls,
    },
    async handler(api, args) {
      const body = {
        to: args.to,
        subject: args.subject,
        body: args.body,
        relatedType: args.relatedTo?.type ?? null,
        relatedId: args.relatedTo?.id ?? null,
      };
      return {
        result: await api.request<EmailMessageDto>('POST', '/v1/emails/drafts', {
          body,
          idempotencyKey: args.idempotencyKey,
          dryRun: args.dryRun,
        }),
        dryRun: args.dryRun === true,
        idempotencyKey: args.idempotencyKey,
      };
    },
  }),
  define({
    name: 'send_email',
    title: 'Send email draft',
    description: 'Send a previously drafted email to its recipients (leaves the system).',
    risk: 'external',
    input: { draftId: z.uuid(), ...writeControls },
    async handler(api, args) {
      return {
        result: await api.request<EmailMessageDto>('POST', `/v1/emails/${args.draftId}/send`, {
          idempotencyKey: args.idempotencyKey,
          dryRun: args.dryRun,
        }),
        dryRun: args.dryRun === true,
        idempotencyKey: args.idempotencyKey,
      };
    },
  }),
  define({
    name: 'send_invoice',
    title: 'Send invoice',
    description: 'Email the invoice with its PDF to the contact (or the given addresses) and mark it sent.',
    risk: 'external',
    input: { id, to: z.array(z.email()).max(10).optional(), ...writeControls },
    async handler(api, args) {
      return {
        result: await api.request<unknown>('POST', `/v1/invoices/${args.id}/send`, {
          body: args.to === undefined ? {} : { to: args.to },
          idempotencyKey: args.idempotencyKey,
          dryRun: args.dryRun,
        }),
        dryRun: args.dryRun === true,
        idempotencyKey: args.idempotencyKey,
      };
    },
  }),
  define({
    name: 'void_invoice',
    title: 'Void invoice',
    description: 'Void an invoice. This cannot be undone.',
    risk: 'irreversible',
    input: { id, reason: z.string().max(500).optional(), ...writeControls },
    async handler(api, args) {
      return {
        result: await api.request<unknown>('POST', `/v1/invoices/${args.id}/void`, {
          body: { reason: args.reason },
          idempotencyKey: args.idempotencyKey,
          dryRun: args.dryRun,
        }),
        dryRun: args.dryRun === true,
        idempotencyKey: args.idempotencyKey,
      };
    },
  }),
] as const;

export function annotationsFor(risk: Risk): Record<string, unknown> {
  return {
    readOnlyHint: risk === 'read',
    destructiveHint: risk === 'irreversible',
    idempotentHint: risk === 'read',
    openWorldHint: risk === 'external',
    'x-risk': risk,
  };
}

export function collectUntrusted(out: ToolOutput): string[] {
  return [...new Set([...(out.untrusted ?? []), ...untrustedPaths(out.result)])].sort();
}
