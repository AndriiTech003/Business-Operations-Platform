import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T, compileToSql, evaluate, hydrate, parseOrThrow } from '../src/index';
import type { SqlField } from '../src/index';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://127.0.0.1:5432/postgres';
const DB_NAME = `bop_test_expr_${randomBytes(6).toString('hex')}`;
const NOW = new Date('2024-05-10T12:00:00.000Z');
const HOUR = 3600000;
const DAY = 24 * HOUR;

const itemType = T.object({
  id: T.number,
  name: T.nullable(T.string),
  status: T.string,
  amount: T.nullable(T.number),
  total: T.nullable(T.money),
  currency: T.string,
  dueDate: T.nullable(T.date),
  active: T.nullable(T.bool),
  archived: T.bool,
  custom: T.object({
    region: T.nullable(T.string),
    score: T.nullable(T.number),
    since: T.nullable(T.date),
  }),
});

const FIELDS: Record<string, SqlField> = {
  'item.id': { sql: 't."id"', type: T.number },
  'item.name': { sql: 't."name"', type: T.nullable(T.string) },
  'item.status': { sql: 't."status"', type: T.string },
  'item.amount': { sql: 't."amount"', type: T.nullable(T.number) },
  'item.total': { sql: 't."total_cents"', type: T.nullable(T.money) },
  'item.dueDate': { sql: 't."due_date"', type: T.nullable(T.date) },
  'item.active': { sql: 't."active"', type: T.nullable(T.bool) },
  'item.archived': { sql: 't."archived"', type: T.bool },
  'item.custom.region': { sql: `(t."custom"->>'region')`, type: T.nullable(T.string) },
  'item.custom.score': { sql: `((t."custom"->>'score')::numeric)`, type: T.nullable(T.number) },
  'item.custom.since': { sql: `((t."custom"->>'since')::timestamptz)`, type: T.nullable(T.date) },
};
const resolveField = (path: string[]): SqlField | null => FIELDS[path.join('.')] ?? null;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Row {
  id: number;
  name: string | null;
  status: string;
  amount: string | null;
  total_cents: string | null;
  due_date: Date | null;
  active: boolean | null;
  archived: boolean;
  custom: Record<string, unknown>;
}

function generateRows(count: number): unknown[][] {
  const r = rng(42);
  const pick = <V>(xs: V[]): V => xs[Math.floor(r() * xs.length)] as V;
  const rows: unknown[][] = [];
  for (let id = 1; id <= count; id++) {
    const custom: Record<string, unknown> = {};
    const region = pick<string | null | undefined>([null, 'EU', 'US', 'APAC', undefined]);
    if (region !== undefined) custom.region = region;
    const score = pick<number | null | undefined>([null, 0, 7, 3.5, -1, 3, undefined]);
    if (score !== undefined) custom.score = score;
    const since = pick<number | null | undefined>([null, undefined, -40, -10, -1, 2]);
    if (since !== undefined)
      custom.since =
        since === null ? null : new Date(NOW.getTime() + since * DAY + Math.floor(r() * 5) * HOUR).toISOString();
    const dueOffset = Math.round(((r() - 0.5) * 20 * DAY) / HOUR) * HOUR + pick([0, 0, 1, 999]);
    rows.push([
      id,
      pick([null, 'alpha', 'beta', 'Gamma', 'delta', '', 'a b', 'Zeta', 'beta2']),
      pick(['sent', 'paid', 'draft', 'void']),
      pick([null, 0, 1.5, -3, 100, 99.99, 1000000, 42, 10]),
      pick([null, 0, 100, 5000, 100000, -250, 5001]),
      r() < 0.15 ? null : new Date(NOW.getTime() + dueOffset),
      pick([null, true, false]),
      r() < 0.5,
      JSON.stringify(custom),
    ]);
  }
  return rows;
}

function toItem(row: Row): unknown {
  return hydrate(
    {
      id: row.id,
      name: row.name,
      status: row.status,
      amount: row.amount,
      total: row.total_cents,
      currency: 'USD',
      dueDate: row.due_date,
      active: row.active,
      archived: row.archived,
      custom: row.custom,
    },
    itemType,
  );
}

let admin: pg.Client;
let db: pg.Client;
let items: { id: number; item: unknown }[] = [];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(`
    CREATE TABLE t (
      id int PRIMARY KEY,
      name text,
      status text NOT NULL,
      amount numeric,
      total_cents int8,
      due_date timestamptz,
      active boolean,
      archived boolean NOT NULL,
      custom jsonb NOT NULL
    )`);
  for (const row of generateRows(200)) {
    await db.query('INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)', row);
  }
  const res = await db.query<Row>('SELECT * FROM t ORDER BY id');
  items = res.rows.map((row) => ({ id: row.id, item: toItem(row) }));
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  if (admin !== undefined) {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.end();
  }
});

async function sqlIds(src: string): Promise<number[]> {
  const compiled = compileToSql(parseOrThrow(src), { resolveField, now: NOW });
  if (!compiled.ok) throw new Error(`not compilable: ${src}: ${compiled.diagnostics[0]?.message ?? ''}`);
  const res = await db.query<{ id: number }>(`SELECT id FROM t WHERE ${compiled.sql} ORDER BY id`, compiled.params);
  return res.rows.map((r) => r.id);
}

function memoryIds(src: string): number[] {
  const ast = parseOrThrow(src);
  return items.filter(({ item }) => evaluate(ast, { vars: { item }, now: () => NOW }) === true).map(({ id }) => id);
}

const conditions = [
  "item.status == 'sent'",
  "item.status != 'sent'",
  "item.status in ['sent', 'paid']",
  "not (item.status in ['sent', 'paid'])",
  'item.status in []',
  'item.name == null',
  'item.name != null',
  "item.name < 'beta'",
  "item.name >= 'Gamma'",
  "not (item.name < 'beta')",
  "item.name in ['alpha', null]",
  'item.amount > 10',
  'item.amount <= 0',
  'not (item.amount > 10)',
  'item.amount == 1.5',
  'item.amount != 42',
  'item.amount > -3.5',
  'item.total > 5000',
  'item.total == 100',
  'item.total <= 0 or item.total == null',
  'not (item.total >= 100)',
  'item.dueDate < now()',
  'item.dueDate < now() - days(1)',
  'item.dueDate >= now() + hours(12)',
  'item.dueDate + days(2) < now()',
  'not (item.dueDate < now() - days(3))',
  'item.dueDate == null',
  'item.dueDate - hours(36) > now() - days(5)',
  'days(1) + item.dueDate > now()',
  'item.active',
  'not item.active',
  'item.active == false',
  'item.active != true',
  'item.active or item.archived',
  'item.active and not item.archived',
  'item.archived == item.active',
  "item.custom.region == 'EU'",
  "item.custom.region != 'EU'",
  "item.custom.region in ['EU', 'US']",
  'item.custom.score > 3',
  'not (item.custom.score > 3)',
  'item.custom.score == null',
  'item.custom.since < now() - days(30)',
  'item.custom.since >= item.dueDate',
  "(item.status == 'sent' and item.dueDate < now() - days(1)) or item.amount > 100",
  "not (item.status == 'draft' or item.custom.region == null)",
  'true',
  'false',
  'null',
  'item.amount < null',
  '1 < 2',
  '(item.amount > 10) == item.active',
];

describe('SQL compilation matches in-memory evaluation', () => {
  it('fixture has rows with nulls', () => {
    expect(items).toHaveLength(200);
  });

  it('hand-written conditions are selective on the fixture', () => {
    const selective = conditions.filter((src) => {
      const count = memoryIds(src).length;
      return count > 0 && count < items.length;
    });
    expect(selective.length).toBeGreaterThanOrEqual(conditions.length - 6);
  });

  it.each(conditions)('%s', async (src) => {
    expect(await sqlIds(src)).toEqual(memoryIds(src));
  });

  const field = (kind: string): fc.Arbitrary<string> =>
    fc.constantFrom(
      ...Object.entries(FIELDS)
        .filter(([, f]) => (f.type.kind === 'nullable' ? f.type.of.kind : f.type.kind) === kind)
        .map(([k]) => k),
    );

  const numLit = fc.constantFrom('0', '1.5', '-3', '10', '42', '99.99', '100', '5000', '-1', '3.5', '7');
  const strLit = fc.constantFrom("'alpha'", "'beta'", "'Gamma'", "''", "'EU'", "'US'", "'sent'", "'paid'", "'z'");
  const dateExpr = fc.oneof(
    fc.constant('now()'),
    fc
      .tuple(fc.constantFrom('+', '-'), fc.constantFrom('days', 'hours'), fc.integer({ min: 0, max: 15 }))
      .map(([op, fn, n]) => `now() ${op} ${fn}(${n})`),
    fc
      .tuple(field('date'), fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 5 }))
      .map(([f, op, n]) => `${f} ${op} days(${n})`),
    field('date'),
  );
  const op = fc.constantFrom('==', '!=', '<', '<=', '>', '>=');
  const atom = fc.oneof(
    fc
      .tuple(fc.oneof(field('number'), field('money')), op, fc.oneof(numLit, field('number')))
      .map(([a, o, b]) => `${a} ${o} ${b}`),
    fc.tuple(field('string'), op, fc.oneof(strLit, field('string'))).map(([a, o, b]) => `${a} ${o} ${b}`),
    fc.tuple(dateExpr, op, dateExpr).map(([a, o, b]) => `${a} ${o} ${b}`),
    fc
      .tuple(
        fc.oneof(field('number'), field('string'), field('date'), field('bool'), field('money')),
        fc.constantFrom('==', '!='),
      )
      .map(([a, o]) => `${a} ${o} null`),
    fc
      .tuple(field('string'), fc.array(fc.oneof(strLit, fc.constant('null')), { maxLength: 3 }))
      .map(([a, xs]) => `${a} in [${xs.join(', ')}]`),
    fc.tuple(field('number'), fc.array(numLit, { maxLength: 3 })).map(([a, xs]) => `${a} in [${xs.join(', ')}]`),
    field('bool'),
    fc
      .tuple(
        field('bool'),
        fc.constantFrom('==', '!='),
        fc.constantFrom('true', 'false', 'item.archived', 'item.active'),
      )
      .map(([a, o, b]) => `${a} ${o} ${b}`),
  );
  const condition = fc.letrec<{ c: string }>((tie) => ({
    c: fc.oneof(
      { depthSize: 'small' },
      atom,
      tie('c').map((c) => `not (${c})`),
      fc.tuple(tie('c'), fc.constantFrom('and', 'or'), tie('c')).map(([a, o, b]) => `(${a}) ${o} (${b})`),
    ),
  })).c;

  it('fast-check generated conditions agree', async () => {
    await fc.assert(
      fc.asyncProperty(condition, async (src) => {
        expect(await sqlIds(src)).toEqual(memoryIds(src));
      }),
      { numRuns: 300 },
    );
  });

  const unsupported = [
    'len(item.name) > 3',
    'item.amount + 1 > 5',
    'item.active ? true : false',
    "contains(item.name, 'a')",
    'item.dueDate - now() > days(1)',
    'item.total == item.total',
    'item.nope == 1',
    "upper(item.status) == 'SENT'",
  ];
  it.each(unsupported)('rejects %j as too complex for scanning', (src) => {
    const r = compileToSql(parseOrThrow(src), { resolveField, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.diagnostics[0]).toMatchObject({
        code: 'sql_unsupported',
        message: 'condition too complex for scanning',
      });
  });
});
