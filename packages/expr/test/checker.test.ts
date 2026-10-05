import { describe, expect, it } from 'vitest';
import { T, analyze, check, isAssignable, parseOrThrow, typeToString } from '../src/index';
import type { Type, TypeContext } from '../src/index';
import { ctx, invoiceType, secretCtx } from './fixtures';

type Case = [string, string | null, string[]];

const summarize = (src: string, context: TypeContext = ctx): { type: string | null; codes: string[] } => {
  const r = analyze(src, context);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  return {
    type: errors.length > 0 ? null : typeToString(r.type),
    codes: r.diagnostics.map((d) => (d.severity === 'warning' ? `w:${d.code}` : d.code)),
  };
};

const literalAndAccessCases: Case[] = [
  ['1', 'number', []],
  ["'a'", 'string', []],
  ['true', 'bool', []],
  ['null', 'null', []],
  ['[1, 2]', 'list<number>', []],
  ['[1, null]', 'list<number?>', []],
  ['[]', 'list<any>', []],
  ["[1, 'a']", null, ['type_mismatch']],
  ['[[1], [2]]', 'list<list<number>>', []],
  ['n', 'number', []],
  ['invoce', null, ['unknown_identifier']],
  ['invoice', 'Invoice', []],
  ['invoice.number', 'string', []],
  ['invoice.company.owner', 'user', []],
  ['invoice.company.owner.email', 'string', []],
  ['invoice.contact.email', 'string?', ['w:nullable_access']],
  ['invoice.contact?.email', 'string?', []],
  ['invoice.nubmer', null, ['unknown_field']],
  ['invoice.custom.region', 'string?', []],
  ['invoice.custom.score > 5', 'bool', []],
  ['steps.remind.output.messageId', 'string', []],
  ['steps.approve.output.decidedBy.name', 'string', []],
  ['steps.missing.output', null, ['unknown_field']],
  ['n.foo', null, ['not_an_object']],
  ['anyv.foo.bar', 'any', []],
  ['anyv[0]', 'any', []],
  ['invoice.tags[0]', 'string?', []],
  ["invoice['number']", 'string', []],
  ['invoice[s]', 'any', []],
  ["invoice['nope']", null, ['unknown_field']],
  ["invoice.tags['x']", null, ['type_mismatch']],
  ['invoice[1]', null, ['type_mismatch']],
  ["invoice['__proto__']", null, ['forbidden_access']],
  ['n[0]', null, ['not_indexable']],
  ['owner.name', 'string?', ['w:nullable_access']],
  ['owner?.name', 'string?', []],
  ['null.x', null, ['null_access']],
  ['null?.x', 'null', []],
  ['nl[0]', 'number?', ['w:nullable_access']],
];

const arithmeticCases: Case[] = [
  ['n + 1', 'number', []],
  ['n - 1', 'number', []],
  ['n * 2', 'number', []],
  ['n / 2', 'number', []],
  ['n % 2', 'number', []],
  ["s + 'x'", 'string', []],
  ['s + 1', null, ['type_mismatch']],
  ['d - d', 'duration', []],
  ['d + dur', 'date', []],
  ['dur + d', 'date', []],
  ['d - dur', 'date', []],
  ['d + d', null, ['type_mismatch']],
  ['dur + dur', 'duration', []],
  ['dur - dur', 'duration', []],
  ['dur * 2', 'duration', []],
  ['2 * dur', 'duration', []],
  ['dur / 2', 'duration', []],
  ['dur * dur', null, ['type_mismatch']],
  ['m + m', 'money', []],
  ['m - m', 'money', []],
  ['m * 2', 'money', []],
  ['m / 2', 'money', []],
  ['m + 1', null, ['type_mismatch']],
  ['m * m', null, ['type_mismatch']],
  ['ns + s', 'string?', []],
  ['n + null', 'null', []],
  ['anyv + 1', 'any', []],
  ['-n', 'number', []],
  ['-dur', 'duration', []],
  ['-m', 'money', []],
  ['-s', null, ['type_mismatch']],
  ['d % 2', null, ['type_mismatch']],
  ['nn * 2', 'number?', []],
];

const comparisonCases: Case[] = [
  ['n < 1', 'bool', []],
  ["s >= 'a'", 'bool', []],
  ['d < now()', 'bool', []],
  ['dur > days(1)', 'bool', []],
  ['m > m', 'bool', []],
  ['m > 100', 'bool', []],
  ['100 <= m', 'bool', []],
  ["n < 'a'", null, ['type_mismatch']],
  ['b < true', null, ['type_mismatch']],
  ['d < n', null, ['type_mismatch']],
  ["n == 'a'", null, ['type_mismatch']],
  ['n == null', 'bool', []],
  ['ns != null', 'bool', []],
  ['m == 5', 'bool', []],
  ['invoice.company.owner == owner', 'bool', []],
  ['list == [1, 2]', 'bool', []],
  ['n in list', 'bool', []],
  ['s in list', null, ['type_mismatch']],
  ["'a' in s", 'bool', []],
  ['n in s', null, ['type_mismatch']],
  ['n in n', null, ['type_mismatch']],
  ["invoice.status in ['sent', 'paid']", 'bool', []],
  ['nn < 3', 'bool', []],
];

const logicCases: Case[] = [
  ['b and nb', 'bool', []],
  ['b or n', null, ['type_mismatch']],
  ['not nb', 'bool', []],
  ['not n', null, ['type_mismatch']],
  ['b ? 1 : 2', 'number', []],
  ['b ? 1 : null', 'number?', []],
  ["b ? 1 : 'a'", null, ['type_mismatch']],
  ['n ? 1 : 2', null, ['type_mismatch']],
  ['nb ? s : ns', 'string?', []],
  ['b ? invoice.company.owner : owner', 'user?', []],
];

const functionCases: Case[] = [
  ['now()', 'date', []],
  ['days(2)', 'duration', []],
  ['hours(n)', 'duration', []],
  ["date('2024-01-01')", 'date', []],
  ['formatMoney(invoice.totalCents, invoice.currency)', 'string', []],
  ['formatMoney(m)', 'string', []],
  ['formatMoney(1)', null, ['arity']],
  ["formatDate(d, 'YYYY')", 'string', []],
  ["formatDate(s, 'YYYY')", null, ['type_mismatch']],
  ['lower(s)', 'string', []],
  ['upper(ns)', 'string?', []],
  ['trim(1)', null, ['type_mismatch']],
  ["contains(s, 'a')", 'bool', []],
  ["contains(invoice.tags, 'x')", 'bool', []],
  ['contains(invoice.tags, 1)', null, ['type_mismatch']],
  ["startsWith(s, 'a')", 'bool', []],
  ['len(s)', 'number', []],
  ['len(list)', 'number', []],
  ['len(n)', null, ['type_mismatch']],
  ['coalesce(ns, s)', 'string', []],
  ['coalesce(ns, null)', 'string?', []],
  ['coalesce(ns, 1)', null, ['type_mismatch']],
  ['round(n)', 'number', []],
  ['round(n, 2)', 'number', []],
  ['min(1, 2)', 'number', []],
  ['max(d, now())', 'date', []],
  ['min(dur, days(1))', 'duration', []],
  ['max(m, m)', 'money', []],
  ['min(1, d)', null, ['type_mismatch']],
  ['min(s)', null, ['type_mismatch']],
  ["role('manager')", 'list<user>', []],
  ['role(s)', null, ['literal_required']],
  ["user('u1')", 'user?', []],
  ['user(s).name', 'string?', ['w:nullable_access']],
  ["secret('x')", null, ['secret_not_allowed']],
  ['days()', null, ['arity']],
  ['days(1, 2)', null, ['arity']],
  ['foo(1)', null, ['unknown_function']],
  ['lenght(s)', null, ['unknown_function']],
  ['now(1)', null, ['arity']],
  ["days('1')", null, ['type_mismatch']],
  ['coalesce()', null, ['arity']],
];

describe('type checker', () => {
  describe.each([
    ['literals and member access', literalAndAccessCases],
    ['arithmetic', arithmeticCases],
    ['comparisons', comparisonCases],
    ['logic and ternary', logicCases],
    ['functions', functionCases],
  ] as [string, Case[]][])('%s', (_group, cases) => {
    it.each(cases)('%j : %s %j', (src, type, codes) => {
      expect(summarize(src)).toEqual({ type, codes });
    });
  });

  const secretCases: [string, string | null, string[]][] = [
    ["secret('token')", 'string', []],
    ['secret(s)', null, ['literal_required']],
    ["secret('')", null, ['literal_required']],
  ];
  it.each(secretCases)('with allowSecret: %j', (src, type, codes) => {
    expect(summarize(src, secretCtx)).toEqual({ type, codes });
  });

  const messageCases: [string, string][] = [
    ['invoce', "Unknown identifier 'invoce'. Did you mean 'invoice'?"],
    ['invoice.nubmer', "Unknown field 'nubmer' on Invoice. Did you mean 'number'?"],
    ['invoice.zzzzzz', "Unknown field 'zzzzzz' on Invoice"],
    ['formatMony(m)', "Unknown function 'formatMony'. Did you mean 'formatMoney'?"],
    ['invoice.contact.email', "'invoice.contact' may be null; use '?.' to read 'email' safely"],
  ];
  it.each(messageCases)('message for %j', (src, message) => {
    const d = analyze(src, ctx).diagnostics[0];
    expect(d?.message).toBe(message);
  });

  it('diagnostics carry spans and 1-based line:col', () => {
    const src = 'n +\n  s';
    const d = analyze(src, ctx).diagnostics[0];
    expect(d).toMatchObject({ code: 'type_mismatch', severity: 'error', span: { start: 0, end: 7 } });
    expect(d?.start).toEqual({ line: 1, col: 1 });
    expect(d?.end).toEqual({ line: 2, col: 4 });
  });

  it('member diagnostics point at the field name', () => {
    const d = analyze("invoice.staus == 'sent'", ctx).diagnostics[0];
    expect(d).toMatchObject({ code: 'unknown_field', span: { start: 8, end: 13 }, start: { line: 1, col: 9 } });
    expect(d?.message).toBe("Unknown field 'staus' on Invoice. Did you mean 'status'?");
  });

  it('check without src reports line 1 positions', () => {
    const r = check(parseOrThrow('n + s'), ctx);
    expect(r.diagnostics[0]?.start).toEqual({ line: 1, col: 1 });
  });

  const expectedCases: [string, Type, string[]][] = [
    ['n > 1', T.bool, []],
    ['n', T.bool, ['type_mismatch']],
    ['nb', T.bool, []],
    ['invoice.company.owner', T.user, []],
    ['now() + days(1)', T.date, []],
    ["role('manager')", T.list(T.user), []],
    ['owner', T.user, ['type_mismatch']],
    ['owner', T.nullable(T.user), []],
    ['invoice.nope', T.string, ['unknown_field']],
  ];
  it.each(expectedCases)('analyze %j with expected type', (src, expected, codes) => {
    expect(analyze(src, ctx, { expected }).diagnostics.map((d) => d.code)).toEqual(codes);
  });

  const templateCases: [string, Type | undefined, string[]][] = [
    ['Hi {{ invoice.number }}', undefined, []],
    ['Hi {{ invoice.nope }}', undefined, ['unknown_field']],
    ['Total {{ formatMoney(m) }}', T.number, ['type_mismatch']],
    ['{{ 1 + }}', undefined, ['parse_error']],
  ];
  it.each(templateCases)('analyze template %j', (src, expected, codes) => {
    const r = analyze(src, ctx, { template: true, expected });
    expect(r.type).toEqual(T.string);
    expect(r.diagnostics.map((d) => d.code)).toEqual(codes);
  });

  const assignCases: [Type, Type, boolean][] = [
    [T.number, T.number, true],
    [T.number, T.nullable(T.number), true],
    [T.nullable(T.number), T.number, false],
    [T.null, T.nullable(T.string), true],
    [T.any, T.date, true],
    [T.list(T.user), T.list(T.object({ id: T.string })), true],
    [invoiceType, T.object({ number: T.string }), true],
    [T.object({ id: T.string, name: T.string, email: T.string }), T.user, true],
    [T.string, T.number, false],
  ];
  it.each(assignCases)('isAssignable(%j, %j) = %s', (from, to, result) => {
    expect(isAssignable(from, to)).toBe(result);
  });

  const typeNameCases: [Type, string][] = [
    [T.list(T.string), 'list<string>'],
    [T.nullable(T.date), 'date?'],
    [T.nullable(T.nullable(T.date)), 'date?'],
    [T.object({ a: T.number, b: T.list(T.bool) }), '{a: number, b: list<bool>}'],
    [invoiceType, 'Invoice'],
  ];
  it.each(typeNameCases)('typeToString %#', (t, s) => {
    expect(typeToString(t)).toBe(s);
  });
});
