import { z } from 'zod';
import { tableSearchSchema } from '../lib/table';

export const loginSearch = z.object({ redirect: z.string().max(500).optional().catch(undefined) });
export const recordSearch = z.object({ tab: z.string().max(40).optional().catch(undefined) });
export const dealsSearch = tableSearchSchema.extend({
  view: z.enum(['board', 'table']).optional().catch(undefined),
  pipelineId: z.string().max(60).optional().catch(undefined),
  forecast: z.boolean().optional().catch(undefined),
});
export const tasksSearch = tableSearchSchema.extend({ scope: z.enum(['mine', 'all']).optional().catch(undefined) });
export const builderSearch = z.object({
  runId: z.string().max(60).optional().catch(undefined),
  node: z.string().max(80).optional().catch(undefined),
});
export const runsSearch = z.object({
  status: z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']).optional().catch(undefined),
  workflowId: z.string().max(60).optional().catch(undefined),
  tests: z.boolean().optional().catch(undefined),
});
export const runSearch = z.object({ node: z.string().max(80).optional().catch(undefined) });
export const approvalsSearch = z.object({ tab: z.enum(['mine', 'pending', 'decided']).optional().catch(undefined) });
export const reportsSearch = z.object({
  period: z.enum(['30d', '90d', '12m', 'ytd', 'custom']).optional().catch(undefined),
  from: z.string().max(40).optional().catch(undefined),
  to: z.string().max(40).optional().catch(undefined),
  ownerId: z.string().max(60).optional().catch(undefined),
  pipelineId: z.string().max(60).optional().catch(undefined),
});
export const settingsSearch = z.object({
  tab: z
    .enum(['team', 'roles', 'fields', 'pipelines', 'emails', 'tokens', 'secrets', 'workspace'])
    .optional()
    .catch(undefined),
  entity: z.enum(['company', 'contact', 'deal']).optional().catch(undefined),
});
