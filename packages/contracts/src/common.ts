import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ACTOR_TYPES = ['user', 'workflow', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const SCOPES = [
  'records:read',
  'records:write',
  'invoices:send',
  'invoices:void',
  'email:send',
  'approvals:read',
  'approvals:create',
  'approvals:decide',
  'workflows:read',
  'workflows:write',
  'reports:read',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

const READ_SCOPES: Scope[] = ['records:read', 'approvals:read', 'workflows:read', 'reports:read'];

export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  viewer: READ_SCOPES,
  member: [...READ_SCOPES, 'records:write', 'email:send', 'invoices:send'],
  manager: [
    ...READ_SCOPES,
    'records:write',
    'email:send',
    'invoices:send',
    'invoices:void',
    'approvals:decide',
    'approvals:create',
    'workflows:write',
  ],
  admin: [...SCOPES],
  owner: [...SCOPES],
};

export const ENTITY_TYPES = ['company', 'contact', 'deal', 'invoice', 'task'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CUSTOM_FIELD_ENTITIES = ['company', 'contact', 'deal'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'select',
  'multi_select',
  'user',
  'relation',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const uuid = z.uuid();
export const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date());

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(500).optional(),
  q: z.string().max(200).optional(),
  sort: z.string().max(100).optional(),
  filter: z.string().max(4000).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'empty', 'not_empty'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const filterChipSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(FILTER_OPS),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])), z.null()])
    .optional(),
});
export type FilterChip = z.infer<typeof filterChipSchema>;
export const filterListSchema = z.array(filterChipSchema).max(20);

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: Array<{ path: string; message: string; nodeId?: string }>;
  current?: unknown;
}

export const subjectTypeSchema = z.enum(['company', 'contact', 'deal', 'invoice', 'task']);
export type SubjectType = z.infer<typeof subjectTypeSchema>;

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
export type PatchShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>> };

export function patchSchema<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape as unknown as Record<string, z.ZodType>)) {
    const bare = field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : field;
    shape[key] = bare.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<S>>;
}
