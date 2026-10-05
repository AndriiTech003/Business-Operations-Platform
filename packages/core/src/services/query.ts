import { filterListSchema, type FilterChip, type ListQuery, type Page } from '@bop/contracts';
import { badRequest } from '../errors';
import { decodeCursor, encodeCursor } from '../util/json';

export type FieldKind = 'string' | 'number' | 'bigint' | 'date' | 'enum' | 'uuid' | 'tags' | 'bool';

export interface ListField {
  kind: FieldKind;
  sortable?: boolean;
  nullable?: boolean;
}

export type FieldMap = Record<string, ListField>;
type Where = Record<string, unknown>;

export function parseFilters(raw: string | undefined): FilterChip[] {
  if (raw === undefined || raw === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest('filter must be a JSON array of {field, op, value}');
  }
  const parsed = filterListSchema.safeParse(json);
  if (!parsed.success)
    throw badRequest(
      'Invalid filter',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return parsed.data;
}

function coerce(kind: FieldKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'number':
      return Number(value);
    case 'bigint':
      return BigInt(Math.round(Number(value)));
    case 'date':
      return new Date(String(value));
    case 'bool':
      return value === true || value === 'true';
    default:
      return String(value);
  }
}

function chipToWhere(chip: FilterChip, fields: FieldMap, customTypes: Record<string, string>): Where {
  if (chip.field.startsWith('custom.')) {
    const key = chip.field.slice(7);
    const type = customTypes[key];
    if (type === undefined) throw badRequest(`Unknown custom field '${key}'`);
    const numeric = type === 'number' || type === 'money';
    const v = chip.value === undefined || chip.value === null ? null : numeric ? Number(chip.value) : chip.value;
    const path = [key];
    switch (chip.op) {
      case 'eq':
        return { custom: { path, equals: v } };
      case 'neq':
        return { NOT: { custom: { path, equals: v } } };
      case 'contains':
        return type === 'multi_select'
          ? { custom: { path, array_contains: [v] } }
          : { custom: { path, string_contains: String(v ?? '') } };
      case 'gt':
        return { custom: { path, gt: v } };
      case 'gte':
        return { custom: { path, gte: v } };
      case 'lt':
        return { custom: { path, lt: v } };
      case 'lte':
        return { custom: { path, lte: v } };
      case 'in':
        return {
          OR: (Array.isArray(chip.value) ? chip.value : [chip.value]).map((x) => ({
            custom: { path, equals: numeric ? Number(x) : x },
          })),
        };
      case 'empty':
      case 'not_empty':
        throw badRequest(`Operator ${chip.op} is not supported for custom fields`);
    }
  }
  const field = fields[chip.field];
  if (field === undefined) throw badRequest(`Unknown filter field '${chip.field}'`);
  const name = chip.field;
  const v = coerce(field.kind, chip.value);
  if (field.kind === 'tags') {
    if (chip.op === 'contains' || chip.op === 'eq') return { [name]: { has: String(chip.value ?? '') } };
    if (chip.op === 'in')
      return { [name]: { hasSome: (Array.isArray(chip.value) ? chip.value : [chip.value]).map(String) } };
    if (chip.op === 'empty') return { [name]: { isEmpty: true } };
    if (chip.op === 'not_empty') return { NOT: { [name]: { isEmpty: true } } };
    throw badRequest(`Operator ${chip.op} is not supported for ${name}`);
  }
  switch (chip.op) {
    case 'eq':
      return { [name]: v };
    case 'neq':
      return { NOT: { [name]: v } };
    case 'contains':
      if (field.kind !== 'string') throw badRequest(`contains is only supported for text fields`);
      return { [name]: { contains: String(chip.value ?? ''), mode: 'insensitive' } };
    case 'gt':
      return { [name]: { gt: v } };
    case 'gte':
      return { [name]: { gte: v } };
    case 'lt':
      return { [name]: { lt: v } };
    case 'lte':
      return { [name]: { lte: v } };
    case 'in':
      return {
        [name]: { in: (Array.isArray(chip.value) ? chip.value : [chip.value]).map((x) => coerce(field.kind, x)) },
      };
    case 'empty':
      return { [name]: null };
    case 'not_empty':
      return { NOT: { [name]: null } };
  }
}

export interface ListPlan {
  where: Where;
  orderBy: Array<Record<string, 'asc' | 'desc'>>;
  take: number;
  skip: number;
  sortField: string;
  direction: 'asc' | 'desc';
  customSort: { key: string; direction: 'asc' | 'desc' } | null;
  offset: number | null;
}

export function planList(
  query: ListQuery,
  fields: FieldMap,
  customTypes: Record<string, string>,
  base: Where,
  defaultSort: string,
  searchFields: string[],
): ListPlan {
  const chips = parseFilters(query.filter);
  const and: Where[] = [base, ...chips.map((c) => chipToWhere(c, fields, customTypes))];
  if (query.q !== undefined && query.q.trim() !== '' && searchFields.length > 0) {
    and.push({ OR: searchFields.map((f) => ({ [f]: { contains: query.q?.trim(), mode: 'insensitive' } })) });
  }
  const sortRaw = query.sort ?? defaultSort;
  const direction: 'asc' | 'desc' = sortRaw.startsWith('-') ? 'desc' : 'asc';
  const sortField = sortRaw.replace(/^-/, '');
  let customSort: ListPlan['customSort'] = null;
  if (sortField.startsWith('custom.')) {
    const key = sortField.slice(7);
    if (customTypes[key] === undefined) throw badRequest(`Unknown sort field '${sortField}'`);
    customSort = { key, direction };
  } else if (fields[sortField]?.sortable !== true && sortField !== 'id') {
    throw badRequest(`Cannot sort by '${sortField}'`);
  }
  const cursor = decodeCursor(query.cursor);
  let offset: number | null = null;
  const nullable = customSort !== null || fields[sortField]?.nullable === true;
  if (cursor !== null) {
    if (cursor.id === '__offset') offset = Number(cursor.v ?? 0);
    else if (!nullable) {
      const field = fields[sortField];
      const value = field === undefined ? cursor.v : coerce(field.kind, cursor.v);
      const cmp = direction === 'asc' ? 'gt' : 'lt';
      and.push({ OR: [{ [sortField]: { [cmp]: value } }, { [sortField]: value, id: { [cmp]: cursor.id } }] });
    }
  }
  if (nullable && offset === null) offset = 0;
  return {
    where: { AND: and },
    orderBy: customSort === null ? [{ [sortField]: direction }, { id: direction }] : [{ id: 'asc' }],
    take: query.limit + 1,
    skip: offset ?? 0,
    sortField,
    direction,
    customSort,
    offset,
  };
}

export function toPage<R extends { id: string }, T>(
  rows: R[],
  plan: ListPlan,
  limit: number,
  map: (r: R) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1] as R;
    if (plan.offset !== null) nextCursor = encodeCursor({ v: plan.offset + limit, id: '__offset' });
    else {
      const raw = (last as unknown as Record<string, unknown>)[plan.sortField];
      const v =
        raw instanceof Date
          ? raw.toISOString()
          : typeof raw === 'bigint'
            ? Number(raw)
            : (raw as string | number | null);
      nextCursor = encodeCursor({ v, id: last.id });
    }
  }
  return { items: items.map(map), nextCursor };
}
