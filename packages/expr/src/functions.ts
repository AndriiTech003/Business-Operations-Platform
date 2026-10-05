import { EvalError } from './errors';
import { compareOrder, kindOf, valuesEqual } from './ops';
import { T, base, comparable, typeToString } from './typesys';
import type { FunctionInfo, HostFunctions, Span, Type } from './types';
import { DAY_MS, Duration, HOUR_MS, Money, deepFreeze, formatDate, formatMoney, parseDateString } from './values';

export class CheckIssue {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly argIndex: number = -1,
  ) {}
}

export interface Runtime {
  now(): Date;
  host: HostFunctions | undefined;
  maxString: number;
  span: Span;
}

export interface FnSpec extends FunctionInfo {
  min: number;
  max: number;
  nullProp: boolean;
  literalArg?: boolean;
  check(args: Type[]): Type;
  run(args: unknown[], rt: Runtime): unknown;
}

function want(fn: string, args: Type[], i: number, kinds: string[]): Type {
  const t = args[i] ?? T.any;
  if (t.kind === 'any' || kinds.includes(t.kind)) return t;
  throw new CheckIssue(
    'type_mismatch',
    `Argument ${i + 1} of ${fn}() must be ${kinds.join(' or ')}, got ${typeToString(t)}`,
    i,
  );
}

function typeError(fn: string, i: number, expected: string, got: unknown, span: Span): never {
  throw new EvalError('type_error', `Argument ${i + 1} of ${fn}() must be ${expected}, got ${kindOf(got)}`, span);
}

function str(fn: string, args: unknown[], i: number, rt: Runtime): string {
  const v = args[i];
  return typeof v === 'string' ? v : typeError(fn, i, 'string', v, rt.span);
}

function num(fn: string, args: unknown[], i: number, rt: Runtime): number {
  const v = args[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : typeError(fn, i, 'number', v, rt.span);
}

function limitString(s: string, rt: Runtime): string {
  if (s.length > rt.maxString) {
    throw new EvalError('string_too_long', `String result exceeds ${rt.maxString} characters`, rt.span);
  }
  return s;
}

function duration(ms: number, rt: Runtime): Duration {
  if (!Number.isFinite(ms)) throw new EvalError('invalid_number', 'Duration is out of range', rt.span);
  return new Duration(ms);
}

function stringFn(name: string, description: string, f: (s: string) => string): FnSpec {
  return {
    name,
    signature: `${name}(s: string): string`,
    description,
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want(name, args, 0, ['string']);
      return T.string;
    },
    run: (args, rt) => limitString(f(str(name, args, 0, rt)), rt),
  };
}

function orderedFn(name: 'min' | 'max'): FnSpec {
  return {
    name,
    signature: `${name}(a: T, b: T, ...): T`,
    description: `Returns the ${name === 'min' ? 'smallest' : 'largest'} argument (numbers, dates, durations or money).`,
    min: 1,
    max: Infinity,
    nullProp: true,
    check: (args) => {
      let result: Type | null = null;
      args.forEach((_, i) => {
        const t = want(name, args, i, ['number', 'date', 'duration', 'money']);
        if (t.kind === 'any') return;
        if (result === null) result = t;
        else if (result.kind !== t.kind) {
          throw new CheckIssue('type_mismatch', `Arguments of ${name}() must all have the same type`, i);
        }
      });
      return result ?? T.any;
    },
    run: (args, rt) => {
      let best: unknown = args[0];
      for (let i = 1; i < args.length; i++) {
        const c = compareOrder(args[i], best, rt.span);
        if (c !== null && (name === 'min' ? c < 0 : c > 0)) best = args[i];
      }
      const k = kindOf(best);
      if (!['number', 'date', 'duration', 'money'].includes(k))
        typeError(name, 0, 'number, date, duration or money', best, rt.span);
      return best;
    },
  };
}

function hostCall<K extends keyof HostFunctions>(rt: Runtime, name: K): NonNullable<HostFunctions[K]> {
  const host = rt.host;
  const fn = host?.[name];
  if (host === undefined || typeof fn !== 'function') {
    throw new EvalError('host_unavailable', `Host function ${name}() is not available`, rt.span);
  }
  return fn.bind(host) as NonNullable<HostFunctions[K]>;
}

function guardHost<R>(rt: Runtime, f: () => R): R {
  try {
    return f();
  } catch (e) {
    if (e instanceof EvalError) throw e;
    throw new EvalError('host_error', e instanceof Error ? e.message : 'Host function failed', rt.span);
  }
}

function checkUser(v: unknown, rt: Runtime): unknown {
  if (v === null || v === undefined) return null;
  const frozen = deepFreeze(v);
  if (typeof frozen !== 'object' || frozen === null || Array.isArray(frozen)) {
    throw new EvalError('host_error', 'Host returned an invalid user', rt.span);
  }
  return frozen;
}

export const FUNCTION_SPECS: readonly FnSpec[] = [
  {
    name: 'now',
    signature: 'now(): date',
    description: 'Current date and time (UTC).',
    min: 0,
    max: 0,
    nullProp: false,
    check: () => T.date,
    run: (_args, rt) => {
      const d = rt.now();
      if (!(d instanceof Date) || Number.isNaN(d.getTime()))
        throw new EvalError('invalid_date', 'now() returned an invalid date', rt.span);
      return new Date(d.getTime());
    },
  },
  {
    name: 'days',
    signature: 'days(n: number): duration',
    description: 'A duration of n days (24 hours each).',
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want('days', args, 0, ['number']);
      return T.duration;
    },
    run: (args, rt) => duration(num('days', args, 0, rt) * DAY_MS, rt),
  },
  {
    name: 'hours',
    signature: 'hours(n: number): duration',
    description: 'A duration of n hours.',
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want('hours', args, 0, ['number']);
      return T.duration;
    },
    run: (args, rt) => duration(num('hours', args, 0, rt) * HOUR_MS, rt),
  },
  {
    name: 'date',
    signature: 'date(s: string): date',
    description: "Parses an ISO 8601 date or date-time string (UTC when no offset is given), e.g. date('2024-05-01').",
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want('date', args, 0, ['string']);
      return T.date;
    },
    run: (args, rt) => {
      const s = str('date', args, 0, rt);
      const d = parseDateString(s);
      if (d === null) throw new EvalError('invalid_date', `Invalid date '${s.slice(0, 50)}'`, rt.span);
      return d;
    },
  },
  {
    name: 'formatMoney',
    signature: 'formatMoney(cents: money|number, currency?: string): string',
    description: 'Formats an amount of minor units (or a money value) as currency, e.g. $1,234.50.',
    min: 1,
    max: 2,
    nullProp: true,
    check: (args) => {
      const first = want('formatMoney', args, 0, ['money', 'number']);
      if (args.length > 1) want('formatMoney', args, 1, ['string']);
      else if (first.kind === 'number') {
        throw new CheckIssue('arity', 'formatMoney() requires a currency when the amount is a number', 0);
      }
      return T.string;
    },
    run: (args, rt) => {
      const v = args[0];
      if (v instanceof Money) {
        const cur = args.length > 1 ? str('formatMoney', args, 1, rt) : v.currency;
        return formatMoney(v.cents, cur);
      }
      const cents = num('formatMoney', args, 0, rt);
      if (args.length < 2)
        throw new EvalError('arity', 'formatMoney() requires a currency when the amount is a number', rt.span);
      return formatMoney(cents, str('formatMoney', args, 1, rt));
    },
  },
  {
    name: 'formatDate',
    signature: 'formatDate(d: date, format: string): string',
    description: 'Formats a date in UTC using tokens YYYY, MM, MMM, DD, D, HH, mm, ss.',
    min: 2,
    max: 2,
    nullProp: true,
    check: (args) => {
      want('formatDate', args, 0, ['date']);
      want('formatDate', args, 1, ['string']);
      return T.string;
    },
    run: (args, rt) => {
      const d = args[0];
      if (!(d instanceof Date)) return typeError('formatDate', 0, 'date', d, rt.span);
      return limitString(formatDate(d, str('formatDate', args, 1, rt)), rt);
    },
  },
  stringFn('lower', 'Converts a string to lower case.', (s) => s.toLowerCase()),
  stringFn('upper', 'Converts a string to upper case.', (s) => s.toUpperCase()),
  stringFn('trim', 'Removes leading and trailing whitespace.', (s) => s.trim()),
  {
    name: 'contains',
    signature: 'contains(haystack: string|list<T>, needle: string|T): bool',
    description: 'True when a string contains a substring or a list contains an item; false for null.',
    min: 2,
    max: 2,
    nullProp: false,
    check: (args) => {
      const hay = base(want('contains', args.map(base), 0, ['string', 'list', 'null']));
      if (hay.kind === 'string') want('contains', args.map(base), 1, ['string', 'null']);
      if (hay.kind === 'list' && !comparable(hay.of, args[1] ?? T.any)) {
        throw new CheckIssue(
          'type_mismatch',
          `Cannot search ${typeToString(hay)} for ${typeToString(args[1] ?? T.any)}`,
          1,
        );
      }
      return T.bool;
    },
    run: (args, rt) => {
      const [hay, needle] = args;
      if (hay === null || hay === undefined) return false;
      if (typeof hay === 'string') {
        if (needle === null || needle === undefined) return false;
        return hay.includes(str('contains', args, 1, rt));
      }
      if (Array.isArray(hay)) return hay.some((item) => valuesEqual(item, needle, rt.span));
      return typeError('contains', 0, 'string or list', hay, rt.span);
    },
  },
  {
    name: 'startsWith',
    signature: 'startsWith(s: string, prefix: string): bool',
    description: 'True when s starts with prefix; false for null.',
    min: 2,
    max: 2,
    nullProp: false,
    check: (args) => {
      want('startsWith', args.map(base), 0, ['string', 'null']);
      want('startsWith', args.map(base), 1, ['string', 'null']);
      return T.bool;
    },
    run: (args, rt) => {
      if (args[0] === null || args[0] === undefined || args[1] === null || args[1] === undefined) return false;
      return str('startsWith', args, 0, rt).startsWith(str('startsWith', args, 1, rt));
    },
  },
  {
    name: 'len',
    signature: 'len(x: string|list<T>): number',
    description: 'Number of characters (code points) in a string or items in a list.',
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want('len', args, 0, ['string', 'list']);
      return T.number;
    },
    run: (args, rt) => {
      const v = args[0];
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      return typeError('len', 0, 'string or list', v, rt.span);
    },
  },
  {
    name: 'coalesce',
    signature: 'coalesce(a: T?, b: T?, ...): T',
    description: 'Returns the first argument that is not null.',
    min: 1,
    max: Infinity,
    nullProp: false,
    check: () => T.any,
    run: (args) => args.find((a) => a !== null && a !== undefined) ?? null,
  },
  {
    name: 'round',
    signature: 'round(n: number, digits?: number): number',
    description: 'Rounds to the given number of decimal digits (0 by default, half away from zero).',
    min: 1,
    max: 2,
    nullProp: true,
    check: (args) => {
      want('round', args, 0, ['number']);
      if (args.length > 1) want('round', args, 1, ['number']);
      return T.number;
    },
    run: (args, rt) => {
      const n = num('round', args, 0, rt);
      const digits = args.length > 1 ? num('round', args, 1, rt) : 0;
      if (!Number.isInteger(digits) || digits < 0 || digits > 15) {
        throw new EvalError('invalid_argument', 'round() digits must be an integer between 0 and 15', rt.span);
      }
      const f = 10 ** digits;
      const r = (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
      return Number.isFinite(r) ? r + 0 : n;
    },
  },
  orderedFn('min'),
  orderedFn('max'),
  {
    name: 'role',
    signature: 'role(name: string): list<user>',
    description: "Users that have the given role, e.g. role('manager'). The name must be a string literal.",
    min: 1,
    max: 1,
    nullProp: false,
    literalArg: true,
    check: () => T.list(T.user),
    run: (args, rt) => {
      const name = str('role', args, 0, rt);
      const fn = hostCall(rt, 'role');
      const users = guardHost(rt, () => fn(name));
      if (!Array.isArray(users)) throw new EvalError('host_error', 'role() host returned a non-list', rt.span);
      return Object.freeze(users.map((u: unknown) => checkUser(u, rt)));
    },
  },
  {
    name: 'user',
    signature: 'user(id: string): user?',
    description: 'Looks up a user by id; null when not found.',
    min: 1,
    max: 1,
    nullProp: true,
    check: (args) => {
      want('user', args, 0, ['string']);
      return T.nullable(T.user);
    },
    run: (args, rt) => {
      const id = str('user', args, 0, rt);
      const fn = hostCall(rt, 'user');
      return checkUser(
        guardHost(rt, () => fn(id)),
        rt,
      );
    },
  },
  {
    name: 'secret',
    signature: 'secret(name: string): string',
    description: "Value of a stored secret, e.g. secret('slack_token'). Only allowed where secrets are enabled.",
    min: 1,
    max: 1,
    nullProp: false,
    literalArg: true,
    check: () => T.string,
    run: (args, rt) => {
      const name = str('secret', args, 0, rt);
      const fn = hostCall(rt, 'secret');
      const v = guardHost(rt, () => fn(name));
      if (typeof v !== 'string') throw new EvalError('host_error', 'secret() host returned a non-string', rt.span);
      return v;
    },
  },
];

export const FUNCTION_MAP: ReadonlyMap<string, FnSpec> = new Map(FUNCTION_SPECS.map((f) => [f.name, f]));

export const FUNCTIONS: readonly FunctionInfo[] = Object.freeze(
  FUNCTION_SPECS.map((f) => Object.freeze({ name: f.name, signature: f.signature, description: f.description })),
);

export function lookupFunction(name: string): FnSpec | undefined {
  return FUNCTION_MAP.get(name);
}
