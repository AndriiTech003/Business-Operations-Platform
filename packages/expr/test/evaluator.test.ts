import { describe, expect, it, vi } from 'vitest';
import {
  Duration,
  EvalError,
  ExprError,
  Money,
  evaluate,
  evaluateExpression,
  parseOrThrow,
  renderTemplate,
} from '../src/index';
import type { EvalEnv } from '../src/index';
import { NOW, ivan, makeEnv, olga } from './fixtures';

const H = 3600000;
const D = 24 * H;

const valueCases: [string, unknown][] = [
  ['1 + 2 * 3', 7],
  ['10 / 4', 2.5],
  ['10 % 4', 2],
  ['-n', -10],
  ["s + ' world'", 'Hello world'],
  ['2.5e-3 * 1000', 2.5],
  ['n > 5 and n < 20', true],
  ['n == 10', true],
  ['n != 10', false],
  ["'b' > 'a'", true],
  ['null == null', true],
  ['n == null', false],
  ['ns == null', true],
  ['nn < 5', false],
  ['nn >= 5', false],
  ['not (nn > 5)', true],
  ['nb and true', false],
  ['nb or true', true],
  ['not nb', true],
  ['nb ? 1 : 2', 2],
  ['b ? 1 : 2', 1],
  ['false and 1 / 0 == 1', false],
  ['true or 1 / 0 == 1', true],
  ['n in [1, 10]', true],
  ["'ell' in s", true],
  ["'x' in s", false],
  ['nn in [1, null]', true],
  ['n in nl', false],
  ["invoice.status in ['sent', 'paid']", true],
  ['[1, 2] == [1, 2]', true],
  ['[1, 2] == [2, 1]', false],
  ['invoice.company == invoice.company', true],
  ['invoice.company.owner.name', 'Olga'],
  ['invoice.contact?.email', null],
  ['invoice.tags[0]', 'urgent'],
  ['invoice.tags[5]', null],
  ['invoice.tags[-1]', null],
  ['invoice.tags[0.5]', null],
  ["invoice['number']", 'INV-1'],
  ["invoice.custom['region']", 'EU'],
  ['invoice.custom.score * 2', 14],
  ['steps.remind.output.messageId', 'msg-1'],
  ['steps.approve.output.decidedBy.email', 'ivan@example.com'],
  ['d + days(1)', new Date('2024-05-02T00:00:00Z')],
  ['d - hours(2)', new Date('2024-04-30T22:00:00Z')],
  ['hours(2) + d', new Date('2024-05-01T02:00:00Z')],
  ["date('2024-05-03') - date('2024-05-01')", new Duration(2 * D)],
  ['now() - days(1) > d', true],
  ['now()', NOW],
  ['days(1) + hours(2)', new Duration(26 * H)],
  ['days(1) * 2', new Duration(2 * D)],
  ['3 * hours(1)', new Duration(3 * H)],
  ['days(1) / 4', new Duration(6 * H)],
  ['days(1) > hours(23)', true],
  ['-dur', new Duration(-H)],
  ["date('2024-05-01T10:00:00+02:00')", new Date('2024-05-01T08:00:00Z')],
  ["date('2024-05-01T10:00')", new Date('2024-05-01T10:00:00Z')],
  ["formatDate(date('2024-05-03T04:05:06Z'), 'YYYY-MM-DD HH:mm:ss')", '2024-05-03 04:05:06'],
  ["formatDate(date('2024-05-03'), 'D MMM YYYY')", '3 May 2024'],
  ['m + m', new Money(2000, 'USD')],
  ['m - m', new Money(0, 'USD')],
  ['m * 1.5', new Money(1500, 'USD')],
  ['m / 3', new Money(333, 'USD')],
  ['2 * m', new Money(2000, 'USD')],
  ['m > 999', true],
  ['m == 1000', true],
  ['1000 >= m', true],
  ['-m', new Money(-1000, 'USD')],
  ['invoice.total', new Money(123456, 'EUR')],
  ['formatMoney(m)', '$10.00'],
  ["formatMoney(123456, 'USD')", '$1,234.56'],
  ["formatMoney(500, 'JPY')", '¥500'],
  ['formatMoney(eur)', '€5.00'],
  ['formatMoney(invoice.totalCents, invoice.currency)', '€1,234.56'],
  ["lower('ABC')", 'abc'],
  ["upper('abc')", 'ABC'],
  ["trim('  a ')", 'a'],
  ["contains('hello', 'ell')", true],
  ["contains(invoice.tags, 'vip')", true],
  ["contains(ns, 'a')", false],
  ["startsWith(s, 'He')", true],
  ["startsWith(ns, 'He')", false],
  ["len('héllo')", 5],
  ["len('\u{1F600}')", 1],
  ['len(invoice.tags)', 2],
  ['coalesce(ns, nn, 3)', 3],
  ['coalesce(ns)', null],
  ['coalesce(n, 1 / 0)', 10],
  ['round(3.14159, 2)', 3.14],
  ['round(2.5)', 3],
  ['round(-2.5)', -3],
  ['min(3, 1, 2)', 1],
  ['max(3, 1, 2)', 3],
  ['max(d, now())', NOW],
  ['min(days(1), hours(1))', new Duration(H)],
  ['lower(ns)', null],
  ['days(nn)', null],
  ["role('manager')", [olga, ivan]],
  ["role('nobody')", []],
  ["user('u1').name", 'Olga'],
  ["user('nope')", null],
  ["secret('token')", 's3cr3t'],
  ['[1, [2, 3]][1][0]', 2],
  ['meta.b[0]', true],
  ['anyv.x', 1],
];

describe('evaluator values', () => {
  it.each(valueCases)('%j evaluates to %j', (src, expected) => {
    expect(evaluateExpression(src, makeEnv())).toEqual(expected);
  });
});

const getter = vi.fn(() => 42);
const accessorObj: Record<string, unknown> = {};
Object.defineProperty(accessorObj, 'x', { get: getter, enumerable: true });

const errorCases: [string, string, Partial<EvalEnv>?][] = [
  ['1 / 0', 'division_by_zero'],
  ['1 % 0', 'division_by_zero'],
  ['days(1) / 0', 'division_by_zero'],
  ['m / 0', 'division_by_zero'],
  ['nobody', 'unknown_identifier'],
  ['invoice.contact.email', 'null_access'],
  ['nl[0]', 'null_access'],
  ['n.x', 'type_error'],
  ['m.cents', 'type_error'],
  ["invoice['__proto__']", 'forbidden_access'],
  ["invoice['constructor']", 'forbidden_access'],
  ['invoice[key]', 'forbidden_access', { vars: { invoice: {}, key: 'prototype' } }],
  ['fn', 'invalid_value', { vars: { fn: () => 1 } }],
  ['obj.fn', 'invalid_value', { vars: { obj: { fn: () => 1 } } }],
  ['obj.x', 'invalid_value', { vars: { obj: accessorObj } }],
  ['obj.inherited', 'type_error', { vars: { obj: Object.create({ inherited: 1 }) as unknown } }],
  ['obj.size', 'type_error', { vars: { obj: new Map() } }],
  ['arr.length', 'type_error', { vars: { arr: [1, 2] } }],
  ["arr['length']", 'type_error', { vars: { arr: [1, 2] } }],
  ['s + s', 'string_too_long', { limits: { maxStringLength: 5 } }],
  ['upper(s)', 'string_too_long', { limits: { maxStringLength: 3 } }],
  ['foo(1)', 'unknown_function'],
  ['1e308 * 10', 'invalid_number'],
  ['b + 1', 'type_error'],
  ['not 1', 'type_error'],
  ['1 and true', 'type_error'],
  ['1 ? 2 : 3', 'type_error'],
  ['n < s', 'type_error'],
  ['m + eur', 'currency_mismatch'],
  ['m > eur', 'currency_mismatch'],
  ['m == eur', 'currency_mismatch'],
  ["formatMoney(100, 'usd')", 'invalid_currency'],
  ["date('2024-02-30')", 'invalid_date'],
  ["date('soon')", 'invalid_date'],
  ["date('2024-01-01') + days(1e9)", 'invalid_date'],
  ['round(n, 1.5)', 'invalid_argument'],
  ['formatMoney(1)', 'arity'],
  ["role('manager')", 'host_unavailable', { host: {} }],
  ["user('u1')", 'host_unavailable', { host: undefined }],
  [
    "secret('x')",
    'host_error',
    {
      host: {
        secret: () => {
          throw new Error('vault down');
        },
      },
    },
  ],
  ['min(1, s)', 'type_error'],
  ['now()', 'invalid_date', { now: () => new Date(Number.NaN) }],
];

describe('evaluator errors', () => {
  it.each(errorCases)('%j throws %s', (src, code, overrides) => {
    let err: unknown;
    try {
      evaluateExpression(src, makeEnv(overrides));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EvalError);
    expect((err as EvalError).code).toBe(code);
  });

  it('never invokes getters or functions from the context', () => {
    expect(getter).not.toHaveBeenCalled();
  });

  it('parse errors surface as ExprError, not EvalError', () => {
    let err: unknown;
    try {
      evaluateExpression('1 +', makeEnv());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExprError);
    expect(err).not.toBeInstanceOf(EvalError);
  });

  it('errors carry the span of the failing node', () => {
    try {
      evaluateExpression('n + 1 / 0', makeEnv());
    } catch (e) {
      expect((e as EvalError).span).toEqual({ start: 4, end: 9 });
    }
  });

  it('list literals and hydrated values are frozen', () => {
    const env = makeEnv();
    expect(Object.isFrozen(evaluateExpression('[1, 2]', env))).toBe(true);
    expect(Object.isFrozen(evaluateExpression('invoice.company', env))).toBe(true);
    expect(Object.isFrozen(evaluateExpression('invoice.tags', env))).toBe(true);
    expect(Object.isFrozen(new Money(1, 'USD'))).toBe(true);
  });

  it('list literal limit is enforced on hand-built ASTs at runtime', () => {
    const ast = parseOrThrow('[1, 2, 3]');
    expect(() => evaluate(ast, { vars: {}, limits: { maxListLength: 2 } })).toThrow(EvalError);
  });

  it('uses the current time when env.now is missing', () => {
    const before = Date.now();
    const value = evaluateExpression('now()', { vars: {} }) as Date;
    expect(value.getTime()).toBeGreaterThanOrEqual(before);
  });
});

const templateCases: [string, string][] = [
  ['Hello {{ s }}!', 'Hello Hello!'],
  [
    'Invoice {{ invoice.number }} is overdue ({{ formatMoney(invoice.totalCents, invoice.currency) }})',
    'Invoice INV-1 is overdue (€1,234.56)',
  ],
  ['{{ d }}', '2024-05-01'],
  ['{{ now() }}', '2024-05-10T12:00:00.000Z'],
  ['[{{ ns }}]', '[]'],
  ['{{ invoice.tags }}', 'urgent, vip'],
  ['{{ invoice.company.owner }}', 'Olga'],
  ['{{ days(3) + hours(4) }}', '3d 4h'],
  ['{{ hours(0.25) }}', '15m'],
  ['{{ b }} {{ n }}', 'true 10'],
  ['{{ m }}', '$10.00'],
  ["{{ '}}' }}", '}}'],
  ['{{ meta }}', '{"a":1,"b":[true,null]}'],
  ['no expressions', 'no expressions'],
];

describe('templates', () => {
  it.each(templateCases)('%j renders %j', (src, expected) => {
    expect(renderTemplate(src, makeEnv())).toBe(expected);
  });

  const templateErrors: [string, string, Partial<EvalEnv>?][] = [
    ['{{meta}}', 'string_too_long', { limits: { maxStringLength: 10 } }],
    ['{{ s }}{{ s }}', 'too_long', { limits: { maxStringLength: 8 } }],
    ['a {{ b', 'unclosed_template'],
    ['{{ 1 / 0 }}', 'division_by_zero'],
  ];
  it.each(templateErrors)('%j throws %s', (src, code, overrides) => {
    expect(() => renderTemplate(src, makeEnv(overrides))).toThrow(expect.objectContaining({ code }) as Error);
  });
});
