import { EvalError, ExprError, isForbidden } from './errors';
import type { FieldInfo, Type } from './types';

export class Money {
  readonly cents: number;
  readonly currency: string;

  constructor(cents: number, currency: string) {
    this.cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  toJSON(): number {
    return this.cents;
  }
}

export class Duration {
  readonly ms: number;

  constructor(ms: number) {
    this.ms = ms;
    Object.freeze(this);
  }

  toJSON(): number {
    return this.ms;
  }
}

export const DAY_MS = 86400000;
export const HOUR_MS = 3600000;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isUserLike(v: unknown): v is { id: string; name: string; email: string } {
  if (!isPlainObject(v)) return false;
  return (
    typeof ownValue(v, 'id') === 'string' &&
    typeof ownValue(v, 'name') === 'string' &&
    typeof ownValue(v, 'email') === 'string'
  );
}

export function ownValue(obj: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined || !desc.enumerable || !('value' in desc)) return undefined;
  return desc.value;
}

function fail(message: string): never {
  throw new ExprError('invalid_value', message);
}

function freezeCopy(v: unknown, depth = 0): unknown {
  if (depth > 100) fail('Value is nested too deeply');
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Money || v instanceof Duration) return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x) => freezeCopy(x, depth + 1)));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      if (isForbidden(key)) continue;
      const value = ownValue(v, key);
      if (value === undefined) continue;
      out[key] = freezeCopy(value, depth + 1);
    }
    return Object.freeze(out);
  }
  return null;
}

export function deepFreeze(v: unknown): unknown {
  return freezeCopy(v);
}

function toNumber(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fail(`Expected ${what}, got ${describe(v)}`);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function parseDateString(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
    s.trim(),
  );
  if (m === null) return null;
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = se === undefined ? 0 : Number(se);
  const ms = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  let t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCDate() !== day) return null;
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    t -= sign * offset * 60000;
  }
  const out = new Date(t);
  return Number.isNaN(out.getTime()) ? null : out;
}

function hydrateDate(v: unknown): Date {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) fail('Invalid date');
    return new Date(v.getTime());
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) fail('Invalid epoch milliseconds');
    return d;
  }
  if (typeof v === 'string') {
    const d = parseDateString(v) ?? new Date(v);
    if (Number.isNaN(d.getTime())) fail(`Invalid date string '${v}'`);
    return d;
  }
  return fail(`Expected date, got ${describe(v)}`);
}

function hydrateMoney(v: unknown, currency: string | undefined): Money {
  if (v instanceof Money) return v;
  if (isPlainObject(v)) {
    const cents = toNumber(ownValue(v, 'cents'), 'money cents');
    const cur = ownValue(v, 'currency');
    return new Money(cents, typeof cur === 'string' ? cur : (currency ?? 'USD'));
  }
  return new Money(toNumber(v, 'money'), currency ?? 'USD');
}

function hydrateInner(json: unknown, type: Type, currency: string | undefined, depth: number): unknown {
  if (depth > 100) fail('Value is nested too deeply');
  switch (type.kind) {
    case 'any':
      return freezeCopy(json);
    case 'nullable':
      return json === null || json === undefined ? null : hydrateInner(json, type.of, currency, depth);
    case 'null':
      if (json !== null && json !== undefined) fail(`Expected null, got ${describe(json)}`);
      return null;
    case 'number':
      return toNumber(json, 'number');
    case 'string':
      if (typeof json !== 'string') fail(`Expected string, got ${describe(json)}`);
      return json;
    case 'bool':
      if (typeof json !== 'boolean') fail(`Expected bool, got ${describe(json)}`);
      return json;
    case 'date':
      return hydrateDate(json);
    case 'duration':
      return json instanceof Duration ? json : new Duration(toNumber(json, 'duration'));
    case 'money':
      return hydrateMoney(json, currency);
    case 'list': {
      if (!Array.isArray(json)) fail(`Expected list, got ${describe(json)}`);
      const items: unknown[] = json;
      return Object.freeze(items.map((item) => hydrateInner(item, type.of, currency, depth + 1)));
    }
    case 'user':
    case 'object': {
      if (!isPlainObject(json)) fail(`Expected object, got ${describe(json)}`);
      const stringField: FieldInfo = { type: { kind: 'string' } };
      const fields: Record<string, FieldInfo> =
        type.kind === 'object' ? type.fields : { id: stringField, name: stringField, email: stringField };
      const cur = ownValue(json, 'currency');
      const sibling = typeof cur === 'string' ? cur : undefined;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(json)) {
        if (isForbidden(key)) continue;
        const value = ownValue(json, key);
        if (value === undefined) continue;
        const field = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
        out[key] =
          field === undefined ? freezeCopy(value) : hydrateInner(value, field.type, sibling ?? 'USD', depth + 1);
      }
      return Object.freeze(out);
    }
  }
}

export function hydrate(json: unknown, type: Type): unknown {
  return hydrateInner(json, type, undefined, 0);
}

export function toJSON(value: unknown): unknown {
  return toJSONInner(value, 0);
}

function toJSONInner(value: unknown, depth: number): unknown {
  if (depth > 100) return null;
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Money) return value.cents;
  if (value instanceof Duration) return value.ms;
  if (Array.isArray(value)) return value.map((v) => toJSONInner(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (isForbidden(key)) continue;
      const v = ownValue(value, key);
      if (v === undefined || typeof v === 'function') continue;
      out[key] = toJSONInner(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(d: Date, fmt: string): string {
  if (Number.isNaN(d.getTime())) throw new EvalError('invalid_date', 'Invalid date');
  return fmt.replace(/YYYY|MMM|MM|DD|D|HH|mm|ss/g, (token) => {
    switch (token) {
      case 'YYYY':
        return pad(d.getUTCFullYear(), 4);
      case 'MMM':
        return MONTHS[d.getUTCMonth()] ?? '';
      case 'MM':
        return pad(d.getUTCMonth() + 1);
      case 'DD':
        return pad(d.getUTCDate());
      case 'D':
        return String(d.getUTCDate());
      case 'HH':
        return pad(d.getUTCHours());
      case 'mm':
        return pad(d.getUTCMinutes());
      default:
        return pad(d.getUTCSeconds());
    }
  });
}

export function formatMoney(cents: number, currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) throw new EvalError('invalid_currency', `Invalid currency code '${currency}'`);
  if (!Number.isFinite(cents)) throw new EvalError('invalid_number', 'Money amount must be finite');
  try {
    const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format(cents / 10 ** digits);
  } catch {
    throw new EvalError('invalid_currency', `Invalid currency code '${currency}'`);
  }
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(ms);
  const units: [string, number][] = [
    ['d', DAY_MS],
    ['h', HOUR_MS],
    ['m', 60000],
    ['s', 1000],
  ];
  const parts: string[] = [];
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
  }
  if (parts.length === 0) return rest > 0 ? `${sign}${rest}ms` : '0s';
  return sign + parts.join(' ');
}

export function formatValue(value: unknown): string {
  return formatInner(value, 0);
}

function formatInner(value: unknown, depth: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (value instanceof Money) {
    try {
      return formatMoney(value.cents, value.currency);
    } catch {
      return `${value.cents} ${value.currency}`;
    }
  }
  if (value instanceof Duration) return formatDuration(value.ms);
  if (Array.isArray(value)) return depth > 20 ? '' : value.map((v) => formatInner(v, depth + 1)).join(', ');
  if (isUserLike(value)) return String(ownValue(value, 'name'));
  if (typeof value === 'object') return JSON.stringify(toJSON(value));
  return '';
}
