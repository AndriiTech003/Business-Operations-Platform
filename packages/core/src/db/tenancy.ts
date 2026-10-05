import { requireTenantId } from '../context';
import type { PrismaClient } from '../generated/prisma/client';

export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'Membership',
  'Company',
  'Contact',
  'Pipeline',
  'Stage',
  'Deal',
  'Invoice',
  'InvoiceLine',
  'Payment',
  'Task',
  'Activity',
  'Comment',
  'Notification',
  'CustomFieldDef',
  'AuditLog',
  'ApiToken',
  'Outbox',
  'EmailTemplate',
  'EmailMessage',
  'Secret',
  'ImportJob',
  'SearchDocument',
  'IdempotencyRecord',
  'Workflow',
  'WorkflowVersion',
  'WorkflowDraft',
  'WorkflowRun',
  'StepRun',
  'Approval',
  'EffectLog',
]);

export const GLOBAL_MODELS: ReadonlySet<string> = new Set(['Tenant', 'User', 'Session']);

export const READ_OPS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
export const CREATE_OPS: ReadonlySet<string> = new Set(['create', 'createMany', 'createManyAndReturn']);
export const WRITE_OPS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
export const UPSERT_OPS: ReadonlySet<string> = new Set(['upsert']);

export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(`Refusing to write ${model} with a tenantId different from the current tenant context`);
    this.name = 'CrossTenantWriteError';
  }
}

type Data = Record<string, unknown>;

function withTenant(model: string, data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => withTenant(model, d, tenantId));
  if (data === null || typeof data !== 'object') return data;
  const record = data as Data;
  if (record['tenantId'] !== undefined && record['tenantId'] !== tenantId) throw new CrossTenantWriteError(model);
  return { ...record, tenantId };
}

function scopeWhere(model: string, where: unknown, tenantId: string): Data {
  const base = (where ?? {}) as Data;
  if (base['tenantId'] !== undefined && base['tenantId'] !== tenantId) {
    return { ...base, AND: [{ tenantId }, { tenantId: base['tenantId'] }] };
  }
  void model;
  return { ...base, tenantId };
}

export function scopeArgs(model: string, operation: string, rawArgs: unknown, tenantId: string): Data {
  const args = { ...((rawArgs ?? {}) as Data) };
  if (READ_OPS.has(operation) || WRITE_OPS.has(operation)) {
    args['where'] = scopeWhere(model, args['where'], tenantId);
    if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
      const data = args['data'] as Data | undefined;
      if (data !== undefined && data['tenantId'] !== undefined && data['tenantId'] !== tenantId)
        throw new CrossTenantWriteError(model);
    }
    return args;
  }
  if (CREATE_OPS.has(operation)) {
    args['data'] = withTenant(model, args['data'], tenantId);
    return args;
  }
  if (UPSERT_OPS.has(operation)) {
    args['where'] = scopeWhere(model, args['where'], tenantId);
    args['create'] = withTenant(model, args['create'], tenantId);
    const update = args['update'] as Data | undefined;
    if (update !== undefined && update['tenantId'] !== undefined && update['tenantId'] !== tenantId)
      throw new CrossTenantWriteError(model);
    return args;
  }
  throw new Error(`Operation ${operation} on tenant model ${model} is not supported by the tenant extension`);
}

export function tenantExtension(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const tenantId = requireTenantId();
          return query(scopeArgs(model, operation, args, tenantId) as typeof args);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof tenantExtension>;

async function _inferTx(c: ScopedClient) {
  return c.$transaction(async (tx) => tx);
}
export type ScopedTx = Awaited<ReturnType<typeof _inferTx>>;
export type Scoped = ScopedClient | ScopedTx;
