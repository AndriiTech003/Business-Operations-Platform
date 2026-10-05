import { EvalError } from './errors';
import type { Span } from './types';
import { Duration, Money, isPlainObject, ownValue } from './values';

export function kindOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof Date) return 'date';
  if (v instanceof Duration) return 'duration';
  if (v instanceof Money) return 'money';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'function') return 'function';
  if (isPlainObject(v)) return 'object';
  return 'unsupported value';
}

function checkCurrency(a: Money, b: Money, span: Span): void {
  if (a.currency !== b.currency) {
    throw new EvalError('currency_mismatch', `Currency mismatch: ${a.currency} vs ${b.currency}`, span);
  }
}

export function valuesEqual(a: unknown, b: unknown, span: Span, depth = 0): boolean {
  if (depth > 100) throw new EvalError('too_deep', 'Value is nested too deeply', span);
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === 'null' || kb === 'null') return ka === kb;
  if (a instanceof Money && b instanceof Money) {
    checkCurrency(a, b, span);
    return a.cents === b.cents;
  }
  if (a instanceof Money && typeof b === 'number') return a.cents === b;
  if (b instanceof Money && typeof a === 'number') return b.cents === a;
  if (ka !== kb) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Duration && b instanceof Duration) return a.ms === b.ms;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(ownValue(a, String(i)), ownValue(b, String(i)), span, depth + 1)) return false;
    }
    return true;
  }
  if (ka === 'object' && typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keysA = Object.keys(a).filter((k) => ownValue(a, k) !== undefined);
    const keysB = Object.keys(b).filter((k) => ownValue(b, k) !== undefined);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!keysB.includes(k)) return false;
      if (!valuesEqual(ownValue(a, k), ownValue(b, k), span, depth + 1)) return false;
    }
    return true;
  }
  return a === b;
}

export function compareOrder(a: unknown, b: unknown, span: Span): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Duration && b instanceof Duration) return a.ms - b.ms;
  if (a instanceof Money && b instanceof Money) {
    checkCurrency(a, b, span);
    return a.cents - b.cents;
  }
  if (a instanceof Money && typeof b === 'number') return a.cents - b;
  if (typeof a === 'number' && b instanceof Money) return a - b.cents;
  throw new EvalError('type_error', `Cannot order ${kindOf(a)} and ${kindOf(b)}`, span);
}

function finite(n: number, span: Span): number {
  if (!Number.isFinite(n)) throw new EvalError('invalid_number', 'Arithmetic result is not a finite number', span);
  return n;
}

function makeDate(ms: number, span: Span): Date {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new EvalError('invalid_date', 'Date arithmetic is out of range', span);
  return d;
}

function money(cents: number, currency: string, span: Span): Money {
  return new Money(finite(Math.round(cents), span), currency);
}

export function arithmetic(op: string, a: unknown, b: unknown, span: Span, maxString: number): unknown {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const mismatch = (): never => {
    throw new EvalError('type_error', `Operator '${op}' cannot be applied to ${kindOf(a)} and ${kindOf(b)}`, span);
  };
  const zero = (): never => {
    throw new EvalError('division_by_zero', 'Division by zero', span);
  };
  switch (op) {
    case '+':
      if (typeof a === 'number' && typeof b === 'number') return finite(a + b, span);
      if (typeof a === 'string' && typeof b === 'string') {
        if (a.length + b.length > maxString) {
          throw new EvalError('string_too_long', `String result exceeds ${maxString} characters`, span);
        }
        return a + b;
      }
      if (a instanceof Date && b instanceof Duration) return makeDate(a.getTime() + b.ms, span);
      if (a instanceof Duration && b instanceof Date) return makeDate(b.getTime() + a.ms, span);
      if (a instanceof Duration && b instanceof Duration) return new Duration(finite(a.ms + b.ms, span));
      if (a instanceof Money && b instanceof Money) {
        checkCurrency(a, b, span);
        return money(a.cents + b.cents, a.currency, span);
      }
      return mismatch();
    case '-':
      if (typeof a === 'number' && typeof b === 'number') return finite(a - b, span);
      if (a instanceof Date && b instanceof Date) return new Duration(a.getTime() - b.getTime());
      if (a instanceof Date && b instanceof Duration) return makeDate(a.getTime() - b.ms, span);
      if (a instanceof Duration && b instanceof Duration) return new Duration(finite(a.ms - b.ms, span));
      if (a instanceof Money && b instanceof Money) {
        checkCurrency(a, b, span);
        return money(a.cents - b.cents, a.currency, span);
      }
      return mismatch();
    case '*':
      if (typeof a === 'number' && typeof b === 'number') return finite(a * b, span);
      if (a instanceof Duration && typeof b === 'number') return new Duration(finite(a.ms * b, span));
      if (typeof a === 'number' && b instanceof Duration) return new Duration(finite(a * b.ms, span));
      if (a instanceof Money && typeof b === 'number') return money(a.cents * b, a.currency, span);
      if (typeof a === 'number' && b instanceof Money) return money(a * b.cents, b.currency, span);
      return mismatch();
    case '/':
      if (typeof a === 'number' && typeof b === 'number') return b === 0 ? zero() : finite(a / b, span);
      if (a instanceof Duration && typeof b === 'number')
        return b === 0 ? zero() : new Duration(finite(a.ms / b, span));
      if (a instanceof Money && typeof b === 'number') return b === 0 ? zero() : money(a.cents / b, a.currency, span);
      return mismatch();
    case '%':
      if (typeof a === 'number' && typeof b === 'number') return b === 0 ? zero() : finite(a % b, span);
      return mismatch();
    default:
      return mismatch();
  }
}
