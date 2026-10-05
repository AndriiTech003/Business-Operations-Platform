import { z } from 'zod';
import { filterChipSchema, type CustomFieldDefDto, type FilterChip, type FilterOp } from '@bop/contracts';

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'select' | 'multi_select' | 'user' | 'relation' | 'bool';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  relationEntity?: string;
  sortable?: boolean;
  filterable?: boolean;
  editable?: boolean;
  width?: number;
  custom?: boolean;
  currency?: string;
}

export const tableSearchSchema = z.object({
  q: z.string().max(200).optional().catch(undefined),
  sort: z.string().max(100).optional().catch(undefined),
  filter: z.array(filterChipSchema).max(20).optional().catch(undefined),
  cols: z.array(z.string().max(100)).max(60).optional().catch(undefined),
});
export type TableSearch = z.infer<typeof tableSearchSchema>;

export const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  text: ['contains', 'eq', 'neq', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'],
  money: ['eq', 'gt', 'gte', 'lt', 'lte'],
  date: ['gt', 'lt', 'gte', 'lte', 'empty', 'not_empty'],
  select: ['eq', 'neq', 'in', 'empty', 'not_empty'],
  multi_select: ['contains', 'empty', 'not_empty'],
  user: ['eq', 'neq', 'empty', 'not_empty'],
  relation: ['eq', 'neq', 'empty', 'not_empty'],
  bool: ['eq'],
};

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'is any of',
  empty: 'is empty',
  not_empty: 'is not empty',
};

export const DATE_OP_LABEL: Partial<Record<FilterOp, string>> = {
  gt: 'after',
  lt: 'before',
  gte: 'on or after',
  lte: 'on or before',
};

export function opLabel(op: FilterOp, type: FieldType): string {
  if (type === 'date') return DATE_OP_LABEL[op] ?? OP_LABEL[op];
  return OP_LABEL[op];
}

export function opNeedsValue(op: FilterOp): boolean {
  return op !== 'empty' && op !== 'not_empty';
}

export function customFieldSpecs(defs: CustomFieldDefDto[]): FieldSpec[] {
  return defs.map((d) => ({
    key: `custom.${d.key}`,
    label: d.label,
    type: d.type as FieldType,
    options: d.options?.choices,
    relationEntity: d.options?.relationEntity,
    currency: d.options?.currency,
    sortable: d.type !== 'multi_select',
    filterable: true,
    editable: true,
    custom: true,
    width: 150,
  }));
}

export function filterParam(chips: FilterChip[] | undefined): string | undefined {
  const valid = (chips ?? []).filter(
    (c) => !opNeedsValue(c.op) || (c.value !== undefined && c.value !== null && c.value !== ''),
  );
  if (valid.length === 0) return undefined;
  return JSON.stringify(
    valid.map((c) =>
      opNeedsValue(c.op) ? { field: c.field, op: c.op, value: c.value } : { field: c.field, op: c.op },
    ),
  );
}

export function listParams(search: TableSearch, extra?: FilterChip[]): Record<string, string | undefined> {
  const chips = [...(extra ?? []), ...(search.filter ?? [])];
  return { q: search.q || undefined, sort: search.sort || undefined, filter: filterParam(chips) };
}

export function toQueryString(search: TableSearch): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(listParams(search))) if (v !== undefined) params.set(k, v);
  return params.toString();
}

export function nextSort(current: string | undefined, key: string): string | undefined {
  if (current === key) return `-${key}`;
  if (current === `-${key}`) return undefined;
  return key;
}

export function sortDirection(current: string | undefined, key: string): 'asc' | 'desc' | null {
  if (current === key) return 'asc';
  if (current === `-${key}`) return 'desc';
  return null;
}

export function getPath(row: unknown, key: string): unknown {
  let cur: unknown = row;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath<T extends object>(row: T, key: string, value: unknown): T {
  const parts = key.split('.');
  const clone: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] as string;
    const next = cur[p];
    cur[p] = next !== null && typeof next === 'object' ? { ...(next as Record<string, unknown>) } : {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
  return clone as T;
}

export function patchFor(key: string, value: unknown): Record<string, unknown> {
  if (key.startsWith('custom.')) return { custom: { [key.slice(7)]: value } };
  return { [key]: value };
}

export interface SavedView {
  name: string;
  search: TableSearch;
  createdAt: string;
}

const viewsKey = (entity: string) => `bop.views.${entity}`;

export function loadViews(entity: string): SavedView[] {
  try {
    const raw = localStorage.getItem(viewsKey(entity));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => {
        const item = v as Partial<SavedView>;
        const search = tableSearchSchema.safeParse(item.search ?? {});
        return typeof item.name === 'string' && search.success
          ? { name: item.name, search: search.data, createdAt: item.createdAt ?? '' }
          : null;
      })
      .filter((v): v is SavedView => v !== null);
  } catch {
    return [];
  }
}

export function saveViews(entity: string, views: SavedView[]): void {
  try {
    localStorage.setItem(viewsKey(entity), JSON.stringify(views));
  } catch {
    return;
  }
}

export function sameSearch(a: TableSearch, b: TableSearch): boolean {
  const norm = (s: TableSearch) =>
    JSON.stringify({ q: s.q ?? '', sort: s.sort ?? '', filter: s.filter ?? [], cols: s.cols ?? [] });
  return norm(a) === norm(b);
}
