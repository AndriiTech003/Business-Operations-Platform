import { T, type FieldInfo, type Type } from '@ashamrai/expr';
import type { CustomFieldDefDto, TriggerEntity } from '@bop/contracts';

export type CustomFieldMap = Partial<Record<string, Pick<CustomFieldDefDto, 'key' | 'label' | 'type' | 'options'>[]>>;

export const USER_TYPE: Type = T.user;

const nullable = (t: Type): Type => T.nullable(t);

function field(type: Type, label?: string): FieldInfo {
  return label === undefined ? { type } : { type, label };
}

export function customFieldType(type: string): Type {
  switch (type) {
    case 'number':
      return T.number;
    case 'money':
      return T.money;
    case 'date':
      return T.date;
    case 'multi_select':
      return T.list(T.string);
    case 'user':
      return T.user;
    default:
      return T.string;
  }
}

function customObject(entity: string, custom: CustomFieldMap): Type {
  const defs = custom[entity] ?? [];
  const fields: Record<string, FieldInfo> = {};
  for (const def of defs)
    fields[def.key] = { type: nullable(customFieldType(def.type)), label: def.label, custom: true };
  return T.object(fields, `${entity}.custom`);
}

const stageType = T.object(
  {
    id: field(T.string),
    name: field(T.string, 'Stage name'),
    kind: field(T.string, 'open | won | lost'),
    probability: field(T.number, 'Win probability, %'),
  },
  'stage',
);

function companyFields(custom: CustomFieldMap): Record<string, FieldInfo> {
  return {
    id: field(T.string),
    name: field(T.string, 'Company name'),
    domain: field(nullable(T.string)),
    industry: field(nullable(T.string)),
    size: field(nullable(T.number), 'Employees'),
    ownerId: field(nullable(T.string)),
    owner: field(nullable(T.user), 'Account owner'),
    tags: field(T.list(T.string)),
    custom: field(customObject('company', custom), 'Custom fields'),
    createdAt: field(T.date),
    updatedAt: field(T.date),
  };
}

function contactFields(custom: CustomFieldMap): Record<string, FieldInfo> {
  return {
    id: field(T.string),
    firstName: field(T.string),
    lastName: field(T.string),
    name: field(T.string, 'Full name'),
    email: field(nullable(T.string)),
    phone: field(nullable(T.string)),
    title: field(nullable(T.string), 'Job title'),
    status: field(T.string, 'lead | active | customer | churned'),
    source: field(nullable(T.string)),
    companyId: field(nullable(T.string)),
    ownerId: field(nullable(T.string)),
    owner: field(nullable(T.user)),
    lastContactedAt: field(nullable(T.date)),
    tags: field(T.list(T.string)),
    custom: field(customObject('contact', custom)),
    createdAt: field(T.date),
    updatedAt: field(T.date),
  };
}

function dealFields(custom: CustomFieldMap): Record<string, FieldInfo> {
  return {
    id: field(T.string),
    title: field(T.string),
    amountCents: field(T.money, 'Amount'),
    currency: field(T.string),
    pipelineId: field(T.string),
    stageId: field(T.string),
    stage: field(stageType),
    companyId: field(nullable(T.string)),
    contactId: field(nullable(T.string)),
    ownerId: field(nullable(T.string)),
    owner: field(nullable(T.user), 'Deal owner'),
    expectedCloseAt: field(nullable(T.date)),
    stageChangedAt: field(T.date),
    lastActivityAt: field(T.date),
    closedAt: field(nullable(T.date)),
    lostReason: field(nullable(T.string)),
    tags: field(T.list(T.string)),
    custom: field(customObject('deal', custom)),
    createdAt: field(T.date),
    updatedAt: field(T.date),
  };
}

function invoiceFields(): Record<string, FieldInfo> {
  return {
    id: field(T.string),
    number: field(T.string, 'Invoice number'),
    status: field(T.string, 'draft | sent | partially_paid | paid | overdue | void'),
    currency: field(T.string),
    issueDate: field(T.date),
    dueDate: field(T.date),
    subtotalCents: field(T.money),
    taxCents: field(T.money),
    totalCents: field(T.money, 'Total'),
    paidCents: field(T.money),
    balanceCents: field(T.money, 'Outstanding balance'),
    companyId: field(T.string),
    contactId: field(nullable(T.string)),
    dealId: field(nullable(T.string)),
    publicUrl: field(T.string),
    sentAt: field(nullable(T.date)),
    paidAt: field(nullable(T.date)),
    createdAt: field(T.date),
    updatedAt: field(T.date),
  };
}

function taskFields(): Record<string, FieldInfo> {
  return {
    id: field(T.string),
    title: field(T.string),
    description: field(nullable(T.string)),
    status: field(T.string, 'open | in_progress | done | cancelled'),
    priority: field(T.number),
    dueAt: field(nullable(T.date)),
    assigneeId: field(nullable(T.string)),
    assignee: field(nullable(T.user)),
    relatedType: field(nullable(T.string)),
    relatedId: field(nullable(T.string)),
    createdByType: field(T.string),
    completedAt: field(nullable(T.date)),
    createdAt: field(T.date),
  };
}

export function baseEntityFields(entity: TriggerEntity, custom: CustomFieldMap = {}): Record<string, FieldInfo> {
  switch (entity) {
    case 'company':
      return companyFields(custom);
    case 'contact':
      return contactFields(custom);
    case 'deal':
      return dealFields(custom);
    case 'invoice':
      return invoiceFields();
    case 'task':
      return taskFields();
  }
}

export const RELATIONS: Record<TriggerEntity, Record<string, TriggerEntity>> = {
  company: {},
  contact: { company: 'company' },
  deal: { company: 'company', contact: 'contact' },
  invoice: { company: 'company', contact: 'contact', deal: 'deal' },
  task: {},
};

export function entityType(entity: TriggerEntity, custom: CustomFieldMap = {}): Type {
  const fields = { ...baseEntityFields(entity, custom) };
  for (const [name, target] of Object.entries(RELATIONS[entity])) {
    const required = entity === 'invoice' && name === 'company';
    const related = T.object(baseEntityFields(target, custom), target);
    fields[name] = { type: required ? related : nullable(related), label: `Related ${target}` };
  }
  if (entity === 'company') {
    fields['contactsCount'] = { type: T.number };
  }
  return T.object(fields, entity);
}

export const UPDATABLE_FIELDS: Record<TriggerEntity, Record<string, Type>> = {
  company: {
    name: T.string,
    domain: T.string,
    industry: T.string,
    size: T.number,
    ownerId: T.string,
    tags: T.list(T.string),
  },
  contact: {
    firstName: T.string,
    lastName: T.string,
    email: T.string,
    phone: T.string,
    title: T.string,
    status: T.string,
    ownerId: T.string,
    tags: T.list(T.string),
  },
  deal: {
    title: T.string,
    amountCents: T.money,
    stage: T.string,
    ownerId: T.string,
    expectedCloseAt: T.date,
    lostReason: T.string,
    tags: T.list(T.string),
  },
  invoice: { notes: T.string, dueDate: T.date },
  task: { title: T.string, status: T.string, priority: T.number, assigneeId: T.string, dueAt: T.date },
};

interface ColumnInfo {
  column: string;
  type: Type;
}

const COLUMNS: Record<TriggerEntity, Record<string, ColumnInfo>> = {
  company: {
    id: { column: 'id::text', type: T.string },
    name: { column: 'name', type: T.string },
    domain: { column: 'domain', type: nullable(T.string) },
    industry: { column: 'industry', type: nullable(T.string) },
    size: { column: 'size', type: nullable(T.number) },
    ownerId: { column: 'owner_id::text', type: nullable(T.string) },
    createdAt: { column: 'created_at', type: T.date },
    updatedAt: { column: 'updated_at', type: T.date },
  },
  contact: {
    id: { column: 'id::text', type: T.string },
    firstName: { column: 'first_name', type: T.string },
    lastName: { column: 'last_name', type: T.string },
    email: { column: 'email', type: nullable(T.string) },
    phone: { column: 'phone', type: nullable(T.string) },
    title: { column: 'title', type: nullable(T.string) },
    status: { column: 'status::text', type: T.string },
    source: { column: 'source', type: nullable(T.string) },
    ownerId: { column: 'owner_id::text', type: nullable(T.string) },
    companyId: { column: 'company_id::text', type: nullable(T.string) },
    lastContactedAt: { column: 'last_contacted_at', type: nullable(T.date) },
    createdAt: { column: 'created_at', type: T.date },
    updatedAt: { column: 'updated_at', type: T.date },
  },
  deal: {
    id: { column: 'id::text', type: T.string },
    title: { column: 'title', type: T.string },
    amountCents: { column: 'amount_cents', type: T.money },
    currency: { column: 'currency', type: T.string },
    stageId: { column: 'stage_id::text', type: T.string },
    pipelineId: { column: 'pipeline_id::text', type: T.string },
    ownerId: { column: 'owner_id::text', type: nullable(T.string) },
    companyId: { column: 'company_id::text', type: nullable(T.string) },
    expectedCloseAt: { column: 'expected_close_at', type: nullable(T.date) },
    stageChangedAt: { column: 'stage_changed_at', type: T.date },
    lastActivityAt: { column: 'last_activity_at', type: T.date },
    closedAt: { column: 'closed_at', type: nullable(T.date) },
    createdAt: { column: 'created_at', type: T.date },
    updatedAt: { column: 'updated_at', type: T.date },
  },
  invoice: {
    id: { column: 'id::text', type: T.string },
    number: { column: 'number', type: T.string },
    status: { column: 'status::text', type: T.string },
    currency: { column: 'currency', type: T.string },
    issueDate: { column: 'issue_date', type: T.date },
    dueDate: { column: 'due_date', type: T.date },
    subtotalCents: { column: 'subtotal_cents', type: T.money },
    taxCents: { column: 'tax_cents', type: T.money },
    totalCents: { column: 'total_cents', type: T.money },
    paidCents: { column: 'paid_cents', type: T.money },
    balanceCents: { column: '(total_cents - paid_cents)', type: T.money },
    companyId: { column: 'company_id::text', type: T.string },
    sentAt: { column: 'sent_at', type: nullable(T.date) },
    createdAt: { column: 'created_at', type: T.date },
    updatedAt: { column: 'updated_at', type: T.date },
  },
  task: {
    id: { column: 'id::text', type: T.string },
    title: { column: 'title', type: T.string },
    status: { column: 'status::text', type: T.string },
    priority: { column: 'priority', type: T.number },
    dueAt: { column: 'due_at', type: nullable(T.date) },
    assigneeId: { column: 'assignee_id::text', type: nullable(T.string) },
    createdAt: { column: 'created_at', type: T.date },
  },
};

export const ENTITY_TABLES: Record<TriggerEntity, string> = {
  company: 'companies',
  contact: 'contacts',
  deal: 'deals',
  invoice: 'invoices',
  task: 'tasks',
};

export function sqlFieldResolver(
  entity: TriggerEntity,
  custom: CustomFieldMap,
  alias = 't',
): (path: string[]) => { sql: string; type: Type } | null {
  const columns = COLUMNS[entity];
  const defs = custom[entity] ?? [];
  return (path) => {
    if (path[0] !== entity) return null;
    if (path.length === 2) {
      const info = columns[path[1] as string];
      if (info === undefined) return null;
      const column = info.column.startsWith('(')
        ? info.column.replace(/([a-z_]+_cents)/g, `${alias}."$1"`)
        : info.column.includes('::')
          ? `${alias}."${info.column.split('::')[0]}"::${info.column.split('::')[1]}`
          : `${alias}."${info.column}"`;
      return { sql: column, type: info.type };
    }
    if (path.length === 3 && path[1] === 'custom') {
      const def = defs.find((d) => d.key === path[2]);
      if (def === undefined) return null;
      const key = def.key.replace(/'/g, "''");
      const text = `(${alias}."custom"->>'${key}')`;
      switch (def.type) {
        case 'number':
          return { sql: `(${text})::numeric`, type: nullable(T.number) };
        case 'money':
          return { sql: `(${text})::numeric`, type: nullable(T.money) };
        case 'date':
          return { sql: `(${text})::timestamptz`, type: nullable(T.date) };
        case 'multi_select':
          return null;
        default:
          return { sql: text, type: nullable(T.string) };
      }
    }
    return null;
  };
}
