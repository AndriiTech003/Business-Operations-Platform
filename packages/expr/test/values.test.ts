import { describe, expect, it } from 'vitest';
import { Duration, ExprError, Money, T, formatValue, hydrate, offsetToPosition, toJSON } from '../src/index';
import type { Type } from '../src/index';

const H = 3600000;

const hydrateCases: [string, unknown, Type, unknown][] = [
  ['date from ISO string', '2024-01-01T10:00:00Z', T.date, new Date('2024-01-01T10:00:00Z')],
  ['date from epoch ms', 1700000000000, T.date, new Date(1700000000000)],
  ['duration from ms', 5000, T.duration, new Duration(5000)],
  [
    'money from cents with sibling currency',
    { amount: 100, currency: 'EUR' },
    T.object({ amount: T.money, currency: T.string }),
    { amount: new Money(100, 'EUR'), currency: 'EUR' },
  ],
  [
    'money without sibling currency falls back to USD',
    { amount: 100 },
    T.object({ amount: T.money }),
    { amount: new Money(100, 'USD') },
  ],
  ['money from {cents, currency}', { cents: 5, currency: 'GBP' }, T.money, new Money(5, 'GBP')],
  ['nullable null', null, T.nullable(T.number), null],
  ['nullable missing', undefined, T.nullable(T.string), null],
  ['unknown fields are kept', { a: 1, extra: { x: [1] } }, T.object({ a: T.number }), { a: 1, extra: { x: [1] } }],
  ['numeric strings become numbers', '12.5', T.number, 12.5],
  ['list of dates', ['2024-01-01', 0], T.list(T.date), [new Date('2024-01-01T00:00:00Z'), new Date(0)]],
  ['any keeps JSON', { a: [1, 'x', null] }, T.any, { a: [1, 'x', null] }],
  [
    'user',
    { id: 'u', name: 'N', email: 'e', role: 'admin' },
    T.user,
    { id: 'u', name: 'N', email: 'e', role: 'admin' },
  ],
  [
    'forbidden keys are dropped',
    JSON.parse('{"__proto__": {"x": 1}, "constructor": 1, "a": 1}') as unknown,
    T.object({ a: T.number }),
    { a: 1 },
  ],
];

describe('hydrate', () => {
  it.each(hydrateCases)('%s', (_name, json, type, expected) => {
    expect(hydrate(json, type)).toEqual(expected);
  });

  const invalidCases: [unknown, Type][] = [
    ['x', T.number],
    [1, T.string],
    ['not a date', T.date],
    [{}, T.list(T.number)],
    ['yes', T.bool],
  ];
  it.each(invalidCases)('rejects %j as %j', (json, type) => {
    expect(() => hydrate(json, type)).toThrow(ExprError);
  });

  it('output is deeply frozen', () => {
    const v = hydrate({ a: { b: [{ c: 1 }] }, extra: { d: [1] } }, T.object({ a: T.any })) as {
      a: { b: { c: number }[] };
      extra: { d: number[] };
    };
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.a)).toBe(true);
    expect(Object.isFrozen(v.a.b)).toBe(true);
    expect(Object.isFrozen(v.a.b[0])).toBe(true);
    expect(Object.isFrozen(v.extra.d)).toBe(true);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });
});

const jsonCases: [string, unknown, unknown][] = [
  ['date to ISO string', new Date('2024-01-01T10:00:00Z'), '2024-01-01T10:00:00.000Z'],
  ['money to cents', new Money(250, 'EUR'), 250],
  ['duration to ms', new Duration(H), H],
  [
    'nested values',
    { at: new Date(0), list: [new Money(1, 'USD'), null] },
    { at: '1970-01-01T00:00:00.000Z', list: [1, null] },
  ],
  ['undefined to null', undefined, null],
];

describe('toJSON', () => {
  it.each(jsonCases)('%s', (_name, value, expected) => {
    expect(toJSON(value)).toEqual(expected);
  });
});

const formatCases: [string, unknown, string][] = [
  ['null', null, ''],
  ['number', 1.5, '1.5'],
  ['bool', false, 'false'],
  ['date at midnight UTC', new Date('2024-01-01T00:00:00Z'), '2024-01-01'],
  ['date with time', new Date('2024-01-01T10:30:00Z'), '2024-01-01T10:30:00.000Z'],
  ['duration days and hours', new Duration(3 * 24 * H + 4 * H), '3d 4h'],
  ['duration minutes', new Duration(15 * 60000), '15m'],
  ['zero duration', new Duration(0), '0s'],
  ['sub-second duration', new Duration(500), '500ms'],
  ['negative duration', new Duration(-H), '-1h'],
  ['money', new Money(123456, 'USD'), '$1,234.56'],
  ['user-like object', { id: 'u1', name: 'Olga', email: 'o@x' }, 'Olga'],
  ['list', ['a', 1, null], 'a, 1, '],
  ['other object as JSON', { a: 1, at: new Date(0) }, '{"a":1,"at":"1970-01-01T00:00:00.000Z"}'],
];

describe('formatValue', () => {
  it.each(formatCases)('%s', (_name, value, expected) => {
    expect(formatValue(value)).toBe(expected);
  });
});

describe('offsetToPosition', () => {
  const cases: [string, number, number, number][] = [
    ['abc', 0, 1, 1],
    ['abc', 3, 1, 4],
    ['a\nbc', 3, 2, 2],
    ['a\n\nb', 3, 3, 1],
    ['abc', 99, 1, 4],
  ];
  it.each(cases)('%j at %i is %i:%i', (src, offset, line, col) => {
    expect(offsetToPosition(src, offset)).toEqual({ line, col });
  });
});
