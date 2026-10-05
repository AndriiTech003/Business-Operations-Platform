import type { FieldInfo, Type } from './types';

const prim = <K extends 'number' | 'string' | 'bool' | 'null' | 'date' | 'duration' | 'money' | 'user' | 'any'>(
  kind: K,
): { kind: K } => Object.freeze({ kind });

function toField(v: Type | FieldInfo): FieldInfo {
  if ('kind' in v) return { type: v };
  return v;
}

function nullable(of: Type): Type {
  if (of.kind === 'nullable' || of.kind === 'null' || of.kind === 'any') return of;
  return { kind: 'nullable', of };
}

export const T: {
  number: Type;
  string: Type;
  bool: Type;
  null: Type;
  date: Type;
  duration: Type;
  money: Type;
  user: Type;
  any: Type;
  list(of: Type): Type;
  object(fields: Record<string, Type | FieldInfo>, name?: string): Type;
  nullable(of: Type): Type;
} = Object.freeze({
  number: prim('number'),
  string: prim('string'),
  bool: prim('bool'),
  null: prim('null'),
  date: prim('date'),
  duration: prim('duration'),
  money: prim('money'),
  user: prim('user'),
  any: prim('any'),
  list: (of: Type): Type => ({ kind: 'list', of }),
  object: (fields: Record<string, Type | FieldInfo>, name?: string): Type => {
    const out: Record<string, FieldInfo> = {};
    for (const [key, value] of Object.entries(fields)) out[key] = toField(value);
    return name === undefined ? { kind: 'object', fields: out } : { kind: 'object', name, fields: out };
  },
  nullable,
});

export const USER_FIELDS: Readonly<Record<string, FieldInfo>> = Object.freeze({
  id: { type: T.string, label: 'ID' },
  name: { type: T.string, label: 'Name' },
  email: { type: T.string, label: 'Email' },
});

export function typeToString(t: Type): string {
  switch (t.kind) {
    case 'list':
      return `list<${typeToString(t.of)}>`;
    case 'nullable':
      return `${typeToString(t.of)}?`;
    case 'object': {
      if (t.name !== undefined && t.name !== '') return t.name;
      const parts = Object.entries(t.fields).map(([k, f]) => `${k}: ${typeToString(f.type)}`);
      return `{${parts.join(', ')}}`;
    }
    default:
      return t.kind;
  }
}

export function base(t: Type): Type {
  return t.kind === 'nullable' ? t.of : t;
}

export function isNullish(t: Type): boolean {
  return t.kind === 'nullable' || t.kind === 'null';
}

export function fieldsOf(t: Type): Record<string, FieldInfo> | null {
  if (t.kind === 'object') return t.fields;
  if (t.kind === 'user') return USER_FIELDS;
  return null;
}

export function isAssignable(from: Type, to: Type): boolean {
  if (to.kind === 'any' || from.kind === 'any') return true;
  if (to.kind === 'nullable') {
    if (from.kind === 'null') return true;
    if (from.kind === 'nullable') return isAssignable(from.of, to.of);
    return isAssignable(from, to.of);
  }
  if (from.kind === 'nullable') return false;
  if (to.kind === 'list') return from.kind === 'list' && isAssignable(from.of, to.of);
  if (to.kind === 'object' || to.kind === 'user') {
    const target = fieldsOf(to);
    const source = fieldsOf(from);
    if (target === null || source === null) return false;
    if (to.kind === 'user' && from.kind === 'user') return true;
    for (const [key, field] of Object.entries(target)) {
      const sf = source[key];
      if (sf === undefined || !isAssignable(sf.type, field.type)) return false;
    }
    return true;
  }
  return from.kind === to.kind;
}

export function sameType(a: Type, b: Type): boolean {
  return isAssignable(a, b) && isAssignable(b, a);
}

export function unify(a: Type, b: Type): Type | null {
  if (a.kind === 'any' || b.kind === 'any') return T.any;
  if (a.kind === 'null') return b.kind === 'null' ? T.null : nullable(b);
  if (b.kind === 'null') return nullable(a);
  const ba = base(a);
  const bb = base(b);
  let u: Type | null = null;
  if (isAssignable(ba, bb)) u = bb;
  else if (isAssignable(bb, ba)) u = ba;
  else if (ba.kind === 'list' && bb.kind === 'list') {
    const inner = unify(ba.of, bb.of);
    u = inner === null ? null : T.list(inner);
  }
  if (u === null) return null;
  return isNullish(a) || isNullish(b) ? nullable(u) : u;
}

export function comparable(a: Type, b: Type): boolean {
  if (a.kind === 'any' || b.kind === 'any' || a.kind === 'null' || b.kind === 'null') return true;
  const ba = base(a);
  const bb = base(b);
  if (ba.kind === 'any' || bb.kind === 'any') return true;
  if ((ba.kind === 'money' && bb.kind === 'number') || (ba.kind === 'number' && bb.kind === 'money')) return true;
  if (ba.kind === 'list' && bb.kind === 'list') return comparable(ba.of, bb.of);
  if ((ba.kind === 'object' || ba.kind === 'user') && (bb.kind === 'object' || bb.kind === 'user')) return true;
  return ba.kind === bb.kind;
}
