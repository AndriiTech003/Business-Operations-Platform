import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { utcConnectionString } from '../../src/db/client';
import { PrismaClient } from '../../src/generated/prisma/client';
import { ConditionScanRepository } from '../../src/raw/condition-scan.repository';
import { createHarness, type Harness } from './helpers';

const ZONE = 'Asia/Kathmandu';
const ZONE_OFFSET_MS = (5 * 60 + 45) * 60_000;
let h: Harness;
let plain: pg.Client;

async function rawRow<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await plain.query(sql, params);
  return r.rows[0] as T;
}

beforeAll(async () => {
  h = await createHarness('tz', {}, { databaseTimezone: ZONE });
  plain = new pg.Client({ connectionString: h.res.databaseUrl });
  await plain.connect();
});

afterAll(async () => {
  await plain?.end();
  await h?.close();
});

describe('timestamps are correct regardless of the Postgres server time zone', () => {
  it('runs against a database whose default time zone is not UTC', async () => {
    const r = await rawRow<{ TimeZone: string }>('SHOW timezone');
    expect(r.TimeZone).toBe(ZONE);
    const prismaZone = await h.core.deps.db.system.$queryRaw<
      Array<{ tz: string }>
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(prismaZone[0]?.tz).toBe('UTC');
  });

  it('a Date written by Prisma is the same instant for raw SQL and now() comparisons', async () => {
    const due = new Date(Date.now() - 30 * 60_000);
    const task = await h.as(() => h.core.tasks.create({ title: 'tz probe', dueAt: due.toISOString() }));
    const row = await rawRow<{ ms: string; past: boolean; created_drift: string }>(
      `SELECT (extract(epoch FROM due_at) * 1000)::bigint::text AS ms, due_at < now() AS past,
        abs(extract(epoch FROM (created_at - now())))::text AS created_drift FROM tasks WHERE id = $1`,
      [task.id],
    );
    expect(Number(row.ms)).toBe(due.getTime());
    expect(row.past).toBe(true);
    expect(Number(row.created_drift)).toBeLessThan(60);
    const back = await h.as(() => h.core.tasks.get(task.id));
    expect(back.dueAt).toBe(due.toISOString());
  });

  it('database defaults (now()) read back through Prisma as the current instant', async () => {
    const t = await h.core.deps.db.system.tenant.findUnique({ where: { id: h.tenantId } });
    expect(Math.abs((t?.createdAt.getTime() ?? 0) - Date.now())).toBeLessThan(120_000);
  });

  it('raw-SQL repositories compare Prisma-written dates with now() and with Date parameters correctly', async () => {
    const company = await h.as(() => h.core.companies.create({ name: 'Zone Co' }));
    const mk = (offsetMs: number) =>
      h.as(() =>
        h.core.invoices.create({
          companyId: company.id,
          issueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
          dueDate: new Date(Date.now() + offsetMs).toISOString(),
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 100, taxRate: 0 }],
        }),
      );
    const overdue = await mk(-2 * 3_600_000);
    const notYet = await mk(2 * 3_600_000);
    const scan = new ConditionScanRepository(h.core.deps.db.system);
    const wf = '00000000-0000-4000-8000-000000000000';
    const viaNow = await scan.matchingIds(h.tenantId, wf, 'invoice', { sql: 't."due_date" < now()', params: [] }, 10);
    expect(viaNow).toContain(overdue.id);
    expect(viaNow).not.toContain(notYet.id);
    const viaParam = await scan.matchingIds(
      h.tenantId,
      wf,
      'invoice',
      { sql: 't."due_date" < $1', params: [new Date()] },
      10,
    );
    expect(viaParam).toContain(overdue.id);
    expect(viaParam).not.toContain(notYet.id);
  });

  it('without the UTC session setting the same write would be shifted by the server offset (control)', async () => {
    const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.res.databaseUrl, max: 1 }) });
    const fixed = new PrismaClient({
      adapter: new PrismaPg({ connectionString: utcConnectionString(h.res.databaseUrl), max: 1 }),
    });
    try {
      const at = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
      const write = async (client: PrismaClient, title: string) =>
        (
          await client.task.create({
            data: { tenantId: h.tenantId, title, dueAt: at },
            select: { id: true },
          })
        ).id;
      const shiftedId = await write(raw, 'tz shifted');
      const correctId = await write(fixed, 'tz correct');
      const ms = async (id: string) =>
        Number(
          (
            await rawRow<{ ms: string }>(
              'SELECT (extract(epoch FROM due_at) * 1000)::bigint::text AS ms FROM tasks WHERE id = $1',
              [id],
            )
          ).ms,
        );
      expect(await ms(correctId)).toBe(at.getTime());
      expect(at.getTime() - (await ms(shiftedId))).toBe(ZONE_OFFSET_MS);
    } finally {
      await raw.$disconnect();
      await fixed.$disconnect();
    }
  });
});
