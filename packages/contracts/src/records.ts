import { z } from 'zod';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, isoDate, patchSchema, subjectTypeSchema, uuid } from './common';

const customValues = z.record(z.string(), z.unknown());
const tags = z.array(z.string().min(1).max(40)).max(30);

export const companyCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).nullish(),
  industry: z.string().trim().max(100).nullish(),
  size: z.number().int().min(0).max(10_000_000).nullish(),
  ownerId: uuid.nullish(),
  source: z.string().max(50).nullish(),
  custom: customValues.optional(),
  tags: tags.optional(),
});
export const companyUpdateSchema = patchSchema(companyCreateSchema);
export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;

export const CONTACT_STATUSES = ['lead', 'active', 'customer', 'churned'] as const;

export const contactCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(''),
  email: z.email().max(200).nullish(),
  phone: z.string().trim().max(50).nullish(),
  title: z.string().trim().max(100).nullish(),
  companyId: uuid.nullish(),
  ownerId: uuid.nullish(),
  status: z.enum(CONTACT_STATUSES).optional(),
  source: z.string().max(50).nullish(),
  custom: customValues.optional(),
  tags: tags.optional(),
});
export const contactUpdateSchema = patchSchema(contactCreateSchema);
export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type ContactCreateInput = z.input<typeof contactCreateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;

export const mergeSchema = z.object({
  targetId: uuid,
  sourceIds: z.array(uuid).min(1).max(20),
});
export type MergeInput = z.infer<typeof mergeSchema>;

export const pipelineCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isDefault: z.boolean().optional(),
  stages: z
    .array(
      z.object({
        id: uuid.optional(),
        name: z.string().trim().min(1).max(100),
        probability: z.number().int().min(0).max(100),
        kind: z.enum(['open', 'won', 'lost']).default('open'),
      }),
    )
    .min(1)
    .max(30),
});
export type PipelineCreate = z.infer<typeof pipelineCreateSchema>;

export const dealCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  companyId: uuid.nullish(),
  contactId: uuid.nullish(),
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  currency: z.string().length(3).default('USD'),
  expectedCloseAt: isoDate.nullish(),
  ownerId: uuid.nullish(),
  custom: customValues.optional(),
  tags: tags.optional(),
});
export const dealUpdateSchema = patchSchema(dealCreateSchema.omit({ pipelineId: true })).extend({
  lostReason: z.string().max(500).nullish(),
});
export type DealCreate = z.infer<typeof dealCreateSchema>;
export type DealCreateInput = z.input<typeof dealCreateSchema>;
export type DealUpdate = z.infer<typeof dealUpdateSchema>;

export const dealMoveSchema = z.object({
  stageId: uuid,
  beforeId: uuid.nullish(),
  afterId: uuid.nullish(),
  lostReason: z.string().max(500).nullish(),
});
export type DealMove = z.infer<typeof dealMoveSchema>;

export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000_00),
  taxRate: z.number().min(0).max(100).default(0),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

export const invoiceCreateSchema = z.object({
  companyId: uuid,
  contactId: uuid.nullish(),
  dealId: uuid.nullish(),
  currency: z.string().length(3).default('USD'),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  notes: z.string().max(5000).nullish(),
  lines: z.array(invoiceLineSchema).max(200).default([]),
});
export const invoiceUpdateSchema = patchSchema(invoiceCreateSchema);
export type InvoiceCreate = z.infer<typeof invoiceCreateSchema>;
export type InvoiceCreateInput = z.input<typeof invoiceCreateSchema>;
export type InvoiceUpdate = z.infer<typeof invoiceUpdateSchema>;

export const paymentCreateSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.string().trim().min(1).max(40).default('bank_transfer'),
  paidAt: isoDate.optional(),
  reference: z.string().max(200).nullish(),
});
export type PaymentCreate = z.infer<typeof paymentCreateSchema>;

export const invoiceSendSchema = z.object({
  to: z.array(z.email()).max(10).optional(),
  subject: z.string().max(300).optional(),
  message: z.string().max(10000).optional(),
});
export type InvoiceSend = z.infer<typeof invoiceSendSchema>;

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).nullish(),
  assigneeId: uuid.nullish(),
  dueAt: isoDate.nullish(),
  priority: z.number().int().min(1).max(4).default(2),
  status: z.enum(TASK_STATUSES).optional(),
  relatedType: subjectTypeSchema.nullish(),
  relatedId: uuid.nullish(),
});
export const taskUpdateSchema = patchSchema(taskCreateSchema);
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskCreateInput = z.input<typeof taskCreateSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
export const bulkCompleteSchema = z.object({ ids: z.array(uuid).min(1).max(500) });

export const commentCreateSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: uuid,
  body: z.string().trim().min(1).max(10000),
});
export type CommentCreate = z.infer<typeof commentCreateSchema>;

export const ACTIVITY_NOTE_KINDS = ['note', 'call', 'email', 'meeting'] as const;
export const noteCreateSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: uuid,
  kind: z.enum(ACTIVITY_NOTE_KINDS).default('note'),
  body: z.string().trim().min(1).max(20000),
  external: z.boolean().optional(),
});
export type NoteCreate = z.infer<typeof noteCreateSchema>;

export const customFieldCreateSchema = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-zA-Z0-9_]*$/),
  label: z.string().trim().min(1).max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z
    .object({
      choices: z.array(z.string().min(1).max(100)).max(100).optional(),
      currency: z.string().length(3).optional(),
      relationEntity: z.enum(['company', 'contact', 'deal']).optional(),
    })
    .nullish(),
  required: z.boolean().default(false),
  indexed: z.boolean().default(false),
  position: z.number().int().min(0).optional(),
});
export const customFieldUpdateSchema = patchSchema(
  customFieldCreateSchema.omit({ entity: true, key: true, type: true }),
);
export const customFieldReorderSchema = z.object({ ids: z.array(uuid).min(1).max(200) });
export type CustomFieldCreate = z.infer<typeof customFieldCreateSchema>;
export type CustomFieldUpdate = z.infer<typeof customFieldUpdateSchema>;

export const importCreateSchema = z.object({
  entity: z.enum(['company', 'contact']),
  fileName: z.string().max(200).default('import.csv'),
  csv: z.string().min(1).max(10_000_000),
  mapping: z.record(z.string(), z.string()).optional(),
  mode: z.enum(['merge', 'skip', 'create']).default('merge'),
});
export type ImportCreate = z.infer<typeof importCreateSchema>;

export const emailTemplateUpsertSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().trim().min(1).max(100),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
});
export type EmailTemplateUpsert = z.infer<typeof emailTemplateUpsertSchema>;

export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(20),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  relatedType: subjectTypeSchema.nullish(),
  relatedId: uuid.nullish(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema>;

export const secretUpsertSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  value: z.string().min(1).max(10000),
});

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1).max(20),
  expiresAt: isoDate.nullish(),
  actorType: z.enum(['user', 'agent']).default('user'),
});
export type ApiTokenCreate = z.infer<typeof apiTokenCreateSchema>;

export const memberInviteSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'manager', 'member', 'viewer']),
});
export const memberUpdateSchema = z.object({ role: z.enum(['admin', 'manager', 'member', 'viewer']) });

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  tenant: z.string().optional(),
});
export const switchTenantSchema = z.object({ tenantId: uuid });

export const approvalCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  details: z.record(z.string(), z.unknown()).default({}),
  assigneeIds: z.array(uuid).max(20).optional(),
  assigneeRole: z.enum(['owner', 'admin', 'manager', 'member']).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 30)
    .optional(),
  callbackUrl: z.url().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  sourceRef: z.record(z.string(), z.unknown()).optional(),
});
export type ApprovalCreate = z.infer<typeof approvalCreateSchema>;

export const approvalDecideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(5000).optional(),
});
export type ApprovalDecide = z.infer<typeof approvalDecideSchema>;

export const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  ownerId: uuid.optional(),
  pipelineId: uuid.optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
