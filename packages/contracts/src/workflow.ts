import { z } from 'zod';
import { DOMAIN_EVENTS } from './events';
import { patchSchema } from './common';

export const TRIGGER_ENTITIES = ['company', 'contact', 'deal', 'invoice', 'task'] as const;
export type TriggerEntity = (typeof TRIGGER_ENTITIES)[number];

export const NODE_TYPES = [
  'condition',
  'switch',
  'create_task',
  'update_record',
  'add_note',
  'notify',
  'create_invoice',
  'send_email',
  'http_request',
  'wait_duration',
  'wait_until',
  'wait_for_event',
  'approval',
  'for_each',
  'ai_step',
  'end',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const manualInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  label: z.string().min(1).max(100),
  type: z.enum(['string', 'number', 'bool', 'date']),
  required: z.boolean().default(false),
});

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('record_event'),
    entity: z.enum(TRIGGER_ENTITIES),
    event: z.enum(DOMAIN_EVENTS),
    filter: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('record_condition'),
    entity: z.enum(TRIGGER_ENTITIES),
    condition: z.string().min(1).max(2000),
    dedupe: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1).max(100),
    timezone: z.string().max(60).optional(),
  }),
  z.object({
    type: z.literal('webhook'),
    schema: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('manual'),
    entity: z.enum(TRIGGER_ENTITIES).optional(),
    inputs: z.array(manualInputSchema).max(20).optional(),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoff: z.enum(['exponential', 'fixed']).default('exponential'),
  initialMs: z.number().int().min(10).max(3_600_000).default(1000),
  maxMs: z.number().int().min(10).max(86_400_000).optional(),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const nodeIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);

export const workflowNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.enum(NODE_TYPES),
  name: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  retry: patchSchema(retryPolicySchema).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  from: z.string().min(1).max(60),
  to: z.string().min(1).max(60),
  label: z.string().max(80).optional(),
});
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  trigger: triggerSchema,
  nodes: z.array(workflowNodeSchema).max(200),
  edges: z.array(workflowEdgeSchema).max(600),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const TRIGGER_NODE_ID = '$trigger';

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  templateKey: z.string().max(60).optional(),
  definition: workflowDefinitionSchema.optional(),
});
export const workflowUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
});
export const draftSaveSchema = z.object({ definition: z.unknown() });
export const publishSchema = z.object({ expectedDraftUpdatedAt: z.string().optional() });
export const manualRunSchema = z.object({
  recordId: z.string().uuid().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
export const testRunSchema = z.object({
  definition: z.unknown().optional(),
  recordId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  approvals: z.enum(['approve', 'reject']).default('approve'),
});

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type RunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface ValidationIssue {
  nodeId: string | null;
  field: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
  span?: { start: number; end: number };
  start?: { line: number; col: number };
  end?: { line: number; col: number };
}

export interface WorkflowDto {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  activeVersion: number | null;
  triggerType: string | null;
  triggerKey: string | null;
  templateKey: string | null;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
  stats?: { runs: number; running: number; failed: number; lastRunAt: string | null };
}

export interface WorkflowDetailDto extends WorkflowDto {
  draft: { definition: WorkflowDefinition; updatedAt: string | null } | null;
  active: { version: number; definition: WorkflowDefinition; publishedAt: string; checksum: string } | null;
  versions: Array<{ version: number; publishedAt: string; publishedBy: string | null; checksum: string }>;
}

export interface StepAttemptDto {
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  worker: string | null;
  error: { message: string; retryable: boolean; code?: string } | null;
}

export interface StepRunDto {
  id: string;
  nodeId: string;
  nodeType: string;
  iteration: number;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  input: unknown;
  output: unknown;
  outcome: string | null;
  error: { message: string; retryable?: boolean; code?: string } | null;
  attempts: StepAttemptDto[];
  idempotencyKey: string;
  scheduledFor: string | null;
  wait: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDto {
  id: string;
  workflowId: string;
  workflowName?: string;
  version: number;
  status: RunStatus;
  triggerType: string;
  dedupeKey: string | null;
  isTest: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: { message: string; nodeId?: string } | null;
  causation: Array<{ runId: string; workflowId: string }>;
}

export interface RunDetailDto extends RunDto {
  triggerPayload: unknown;
  context: Record<string, unknown>;
  definition: WorkflowDefinition;
  steps: StepRunDto[];
  traversedEdges: Array<{ from: string; to: string; label: string | null }>;
}

export interface WorkflowTemplateDto {
  key: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}
