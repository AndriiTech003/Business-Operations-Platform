import { describe, expect, it } from 'vitest';
import {
  FUNCTIONS,
  T,
  collectHostCalls,
  collectPaths,
  compileToSql,
  complete,
  parseOrThrow,
  parseTemplate,
} from '../src/index';
import type { HostCalls, SqlField } from '../src/index';
import { ctx, secretCtx } from './fixtures';

describe('collectHostCalls', () => {
  const cases: [string, string, boolean, Partial<HostCalls>][] = [
    ['role literal', "role('manager')", false, { roles: ['manager'] }],
    ['literal and dynamic users', "user('u1') == user(invoice.ownerId)", false, { users: ['u1'], dynamicUsers: true }],
    ['secret in template', "Bearer {{ secret('token') }} {{ secret('token') }}", true, { secrets: ['token'] }],
    ['none', 'invoice.total > 5', false, {}],
  ];
  it.each(cases)('%s', (_name, src, template, expected) => {
    const input = template ? parseTemplate(src) : parseOrThrow(src);
    expect(collectHostCalls(input)).toEqual({ roles: [], users: [], secrets: [], dynamicUsers: false, ...expected });
  });
});

describe('collectPaths', () => {
  const cases: [string, string, boolean, string[][]][] = [
    ['nested member path', 'invoice.company.owner', false, [['invoice', 'company', 'owner']]],
    ['several paths', 'steps.remind.output.messageId == x', false, [['steps', 'remind', 'output', 'messageId'], ['x']]],
    [
      'literal index and dynamic index',
      "invoice['number'] + a.b[0].c",
      false,
      [
        ['invoice', 'number'],
        ['a', 'b'],
      ],
    ],
    [
      'template paths deduplicated',
      'Hi {{ contact.firstName }} {{ contact.firstName }} {{ len(invoice.tags) }}',
      true,
      [
        ['contact', 'firstName'],
        ['invoice', 'tags'],
      ],
    ],
  ];
  it.each(cases)('%s', (_name, src, template, expected) => {
    const input = template ? parseTemplate(src) : parseOrThrow(src);
    expect(collectPaths(input)).toEqual(expected);
  });
});

describe('complete', () => {
  const labels = (src: string, offset = src.length, opts?: { template?: boolean }, context = ctx): string[] =>
    complete(src, offset, context, opts).options.map((o) => o.label);

  const cases: [string, string, number | null, string[], string[]][] = [
    ['variable prefix', 'inv', null, ['invoice'], ['n']],
    ['all fields after a dot', 'invoice.', null, ['id', 'number', 'company', 'custom'], ['invoice']],
    ['fields filtered by partial', 'invoice.nu', null, ['number'], ['id']],
    ['user fields', 'invoice.company.owner.', null, ['id', 'name', 'email'], []],
    ['optional chaining', 'invoice.contact?.em', null, ['email'], ['firstName']],
    ['step outputs', 'steps.remind.output.', null, ['messageId'], []],
    ['functions', 'le', null, ['len'], ['lower']],
    ['keywords', 'n an', null, ['and'], []],
    ['inside a string literal', "'inv", null, [], ['invoice']],
    ['no fields on a number', 'n.', null, [], ['n']],
    ['parenthesized object', '(invoice).ar', null, ['archived'], []],
    ['call result', "user('x').", null, ['id', 'name', 'email'], []],
    ['index result of a list of strings', 'invoice.tags[0].', null, [], ['id']],
    ['secret hidden by default', 'sec', null, [], ['secret']],
  ];
  it.each(cases)('%s', (_name, src, offset, include, exclude) => {
    const got = labels(src, offset ?? src.length);
    for (const l of include) expect(got).toContain(l);
    for (const l of exclude) expect(got).not.toContain(l);
  });

  it('secret is offered when allowed', () => {
    expect(labels('sec', 3, undefined, secretCtx)).toEqual(['secret']);
  });

  it('field options carry types and labels; from/to cover the partial identifier', () => {
    const src = 'invoice.custom.reg + 1';
    const r = complete(src, 18, ctx);
    expect(r.from).toBe(15);
    expect(r.to).toBe(18);
    expect(r.options).toEqual([{ label: 'region', kind: 'field', type: 'string?', detail: 'Region' }]);
  });

  it('to extends over the rest of the identifier under the cursor', () => {
    const r = complete('invoice.numb + 1', 10, ctx);
    expect([r.from, r.to]).toEqual([8, 12]);
  });

  it('function options carry signature and apply text', () => {
    const opt = complete('formatM', 7, ctx).options[0];
    expect(opt).toMatchObject({ label: 'formatMoney', kind: 'function', apply: 'formatMoney(', type: 'string' });
    expect(opt?.detail).toContain('formatMoney(cents: money|number, currency?: string): string');
  });

  it('template mode completes only inside {{ }}', () => {
    const src = 'Hi {{ invoice.nu }} invoice.';
    const inside = complete(src, src.indexOf(' }}'), ctx, { template: true });
    expect(inside.options.map((o) => o.label)).toEqual(['number']);
    expect(inside.from).toBe(src.indexOf('nu'));
    expect(complete(src, src.length, ctx, { template: true }).options).toEqual([]);
    expect(complete('Hi {{ inv', 9, ctx, { template: true }).options.map((o) => o.label)).toEqual(['invoice']);
  });
});

describe('FUNCTIONS', () => {
  it('lists every whitelisted function with signature and description', () => {
    expect(FUNCTIONS.map((f) => f.name)).toEqual([
      'now',
      'days',
      'hours',
      'date',
      'formatMoney',
      'formatDate',
      'lower',
      'upper',
      'trim',
      'contains',
      'startsWith',
      'len',
      'coalesce',
      'round',
      'min',
      'max',
      'role',
      'user',
      'secret',
    ]);
    for (const f of FUNCTIONS) {
      expect(f.signature.startsWith(`${f.name}(`)).toBe(true);
      expect(f.description.length).toBeGreaterThan(10);
    }
  });
});

const fields: Record<string, SqlField> = {
  'invoice.status': { sql: 't."status"', type: T.string },
  'invoice.dueDate': { sql: 't."due_date"', type: T.date },
  'invoice.archived': { sql: 't."archived"', type: T.bool },
  'invoice.paid': { sql: 't."paid"', type: T.nullable(T.bool) },
  'invoice.total': { sql: 't."total_cents"', type: T.money },
  'invoice.amount': { sql: 't."amount"', type: T.number },
  'invoice.tags': { sql: 't."tags"', type: T.list(T.string) },
  'invoice.custom.region': { sql: `(t."custom"->>'region')`, type: T.nullable(T.string) },
};
const now = new Date('2024-05-10T12:00:00.000Z');
const resolveField = (path: string[]): SqlField | null => fields[path.join('.')] ?? null;

describe('compileToSql', () => {
  const okCases: [string, string, unknown[], number?][] = [
    ["invoice.status == 'sent'", '(t."status" IS NOT DISTINCT FROM $1::text)', ['sent']],
    [
      'invoice.dueDate < now() - days(1)',
      `COALESCE((t."due_date" < ($1::timestamptz - ($2::float8 * INTERVAL '1 millisecond'))), FALSE)`,
      [now.toISOString(), 86400000],
    ],
    ['invoice.amount >= 10', 'COALESCE((t."amount" >= $3::numeric), FALSE)', [10], 2],
    ['invoice.archived', 'COALESCE(t."archived", FALSE)', []],
    [
      'not invoice.paid or invoice.total > 100',
      '((NOT COALESCE(t."paid", FALSE)) OR COALESCE((t."total_cents" > $1::numeric), FALSE))',
      [100],
    ],
    [
      "invoice.custom.region in ['EU', null]",
      `((t."custom"->>'region') IS NOT DISTINCT FROM $1::text OR (t."custom"->>'region') IS NOT DISTINCT FROM NULL)`,
      ['EU'],
    ],
    ["invoice.status < 'b'", 'COALESCE((t."status" COLLATE "C" < $1::text), FALSE)', ['b']],
    ['invoice.amount != -5', '(t."amount" IS DISTINCT FROM $1::numeric)', [-5]],
  ];
  it.each(okCases)('compiles %j', (src, sql, params, paramOffset) => {
    expect(compileToSql(parseOrThrow(src), { resolveField, now, paramOffset })).toEqual({ ok: true, sql, params });
  });

  const unsupported: [string, string][] = [
    ['len(invoice.status) > 3', 'len(invoice.status)'],
    ['invoice.amount + 1 > 5', 'invoice.amount + 1'],
    ['invoice.archived ? true : false', 'invoice.archived ? true : false'],
    ["'EU' in invoice.tags", 'invoice.tags'],
    ['invoice.total == invoice.total', 'invoice.total == invoice.total'],
    ['invoice.unknown == 1', 'invoice.unknown'],
    ['invoice.amount', 'invoice.amount'],
    ['invoice.dueDate < now() - days(invoice.amount)', 'days(invoice.amount)'],
  ];
  it.each(unsupported)('rejects %j at %j', (src, offending) => {
    const r = compileToSql(parseOrThrow(src), { resolveField, now });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.diagnostics[0];
      expect(d?.code).toBe('sql_unsupported');
      expect(d?.message).toBe('condition too complex for scanning');
      expect(src.slice(d?.span.start, d?.span.end)).toBe(offending);
    }
  });
});
