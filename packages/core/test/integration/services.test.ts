import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInContext, type ExecContext } from '../../src/context';
import { DomainError } from '../../src/errors';
import { ConditionScanRepository } from '../../src/raw/condition-scan.repository';
import { CustomFieldIndexRepository } from '../../src/raw/custom-field-index.repository';
import { ReportsRepository } from '../../src/raw/reports.repository';
import { RecordsQueryRepository } from '../../src/raw/records-query.repository';
import { SearchRepository } from '../../src/raw/search.repository';
import { seedDemo, type SeedResult } from '../../src/seed/demo';
import { WorkerRuntime } from '../../src/runtime/worker';
import { createHarness, waitFor, type Harness } from './helpers';

let h: Harness;
let demo: SeedResult;
let other: ExecContext;
let runtime: WorkerRuntime | null = null;

const inA = <T>(fn: () => Promise<T>) =>
  runInContext(
    { tenantId: demo.tenantId, actor: { type: 'user', id: demo.users['owner'] as string }, causation: [] },
    fn,
  );
const inB = <T>(fn: () => Promise<T>) => runInContext(other, fn);

beforeAll(async () => {
  h = await createHarness('services');
  demo = await seedDemo(h.core, { slug: `demo-${h.res.id}`, workflows: false });
  const ownerB = await h.core.accounts.createUser(`b-${h.res.id}@test.dev`, 'B', 'pw-123456');
  const tenantB = await h.core.accounts.createTenant({ slug: `b-${h.res.id}`, name: 'B', ownerId: ownerB });
  other = { tenantId: tenantB, actor: { type: 'user', id: ownerB }, causation: [] };
  await inB(async () => {
    const c = await h.core.companies.create({ name: 'Bravo Secret Holdings', domain: 'bravo.test', custom: {} });
    const d = await h.core.deals.create({ title: 'Bravo deal', amountCents: 999_900, companyId: c.id });
    const pipeline = await h.core.deals.defaultPipeline();
    await h.core.deals.move(d.id, { stageId: pipeline.stages.find((s) => s.kind === 'won')!.id });
    const inv = await h.core.invoices.create({
      companyId: c.id,
      issueDate: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      dueDate: new Date(Date.now() - 95 * 86_400_000).toISOString(),
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 777_700, taxRate: 0 }],
    });
    await h.core.deps.db.scoped.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } });
    await h.core.search.index('company', c.id);
  });
});

afterAll(async () => {
  await runtime?.stop();
  if (runtime === null) await h?.core.close();
  await h?.res.drop();
});

describe('raw SQL repositories always filter by tenant', () => {
  it('reports: pipeline, revenue, AR aging and activity only see the requested tenant', async () => {
    const repo = new ReportsRepository(h.core.deps.db.system);
    const f = (tenantId: string) => ({
      tenantId,
      from: new Date(Date.now() - 400 * 86_400_000),
      to: new Date(),
      ownerId: null,
      pipelineId: null,
    });
    const aging = await repo.arAging(demo.tenantId, new Date());
    expect(aging.some((r) => r.company === 'Bravo Secret Holdings')).toBe(false);
    const agingB = await repo.arAging(other.tenantId, new Date());
    expect(agingB.map((r) => r.company)).toEqual(['Bravo Secret Holdings']);
    const stagesB = await repo.pipelineStages(f(other.tenantId));
    expect(stagesB.reduce((a, s) => a + Number(s.deals), 0)).toBe(1);
    const stagesA = await repo.pipelineStages(f(demo.tenantId));
    expect(stagesA.reduce((a, s) => a + Number(s.deals), 0)).toBe(36);
    const revB = await repo.revenueByMonth(f(other.tenantId));
    expect(revB.reduce((a, m) => a + Number(m.won ?? 0), 0)).toBe(999_900);
    const actB = await repo.activityByActorType(f(other.tenantId));
    const actA = await repo.activityByActorType(f(demo.tenantId));
    expect(actB.reduce((a, r) => a + Number(r.count), 0)).toBeLessThan(actA.reduce((a, r) => a + Number(r.count), 0));
    const summaryB = await repo.pipelineSummary(f(other.tenantId));
    expect(Number(summaryB?.open_deals)).toBe(0);
  });

  it('search never returns another tenant’s documents', async () => {
    const repo = new SearchRepository(h.core.deps.db.system);
    expect(await repo.search(demo.tenantId, 'Bravo Secret', null, 5)).toEqual([]);
    expect((await repo.search(other.tenantId, 'Bravo Secret', null, 5)).map((r) => r.title)).toEqual([
      'Bravo Secret Holdings',
    ]);
    expect((await repo.search(demo.tenantId, 'northwnd', ['company'], 5))[0]?.title).toBe('Northwind Traders');
  });

  it('condition scan, custom sort and custom-field index DDL are tenant-bound', async () => {
    const scan = new ConditionScanRepository(h.core.deps.db.system);
    const compiled = { sql: 't."total_cents" > $1', params: [0] };
    const idsB = await scan.matchingIds(
      other.tenantId,
      '00000000-0000-4000-8000-000000000000',
      'invoice',
      compiled,
      100,
    );
    const idsA = await scan.matchingIds(
      demo.tenantId,
      '00000000-0000-4000-8000-000000000000',
      'invoice',
      compiled,
      100,
    );
    expect(idsB).toHaveLength(1);
    expect(idsA).toHaveLength(16);
    expect(idsA).not.toContain(idsB[0]);
    const sort = new RecordsQueryRepository(h.core.deps.db.system);
    const bCompanies = await inB(() => h.core.deps.db.scoped.company.findMany({ select: { id: true } }));
    expect(
      await sort.orderByCustom(
        demo.tenantId,
        'company',
        bCompanies.map((c) => c.id),
        'region',
        false,
        'asc',
        10,
        0,
      ),
    ).toEqual([]);
    const ddl = new CustomFieldIndexRepository(h.core.deps.db.system);
    const name = ddl.indexName(demo.tenantId, 'company', 'region');
    expect(await ddl.indexExists(name)).toBe(true);
    const plan = await ddl.explainUsesIndex(demo.tenantId, 'company', 'region', 'EU');
    expect(plan).toContain(name);
    await expect(ddl.createIndex(demo.tenantId, 'company', "x'; drop table companies; --", 'text')).rejects.toThrow(
      'Invalid',
    );
  });
});

describe('domain services', () => {
  it('custom fields are validated with a dynamic schema and limited to 5 indexed per entity', async () => {
    await inA(async () => {
      const c = await h.core.companies.create({ name: 'Valid Co', custom: { region: 'EMEA', tier: 'Gold' } });
      expect(c.custom).toEqual({ region: 'EMEA', tier: 'Gold' });
      await expect(h.core.companies.create({ name: 'Bad Co', custom: { region: 'Moon' } })).rejects.toMatchObject({
        status: 422,
      });
      await expect(h.core.companies.create({ name: 'Bad Co', custom: { unknown: 1 } })).rejects.toMatchObject({
        status: 422,
      });
      for (let i = 0; i < 4; i += 1)
        await h.core.customFields.create({
          entity: 'company',
          key: `ix${i}`,
          label: `Ix ${i}`,
          type: 'text',
          required: false,
          indexed: true,
        });
      await expect(
        h.core.customFields.create({
          entity: 'company',
          key: 'ix9',
          label: 'Ix 9',
          type: 'text',
          required: false,
          indexed: true,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  it('optimistic locking returns 412 with the saved record', async () => {
    await inA(async () => {
      const d = await h.core.deals.create({ title: 'Locking', amountCents: 100 });
      await h.core.deals.update(d.id, { amountCents: 200 }, d.version);
      const err = await h.core.deals.update(d.id, { amountCents: 300 }, d.version).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).status).toBe(412);
      expect(((err as DomainError).details.current as { amountCents: number }).amountCents).toBe(200);
    });
  });

  it('kanban moves use fractional positions between neighbours and emit stage events', async () => {
    await inA(async () => {
      const pipeline = await h.core.deals.defaultPipeline();
      const stage = pipeline.stages.find((s) => s.name === 'Proposal')!;
      const won = pipeline.stages.find((s) => s.kind === 'won')!;
      const a = await h.core.deals.create({ title: 'A', stageId: stage.id });
      const b = await h.core.deals.create({ title: 'B', stageId: stage.id });
      const c = await h.core.deals.create({ title: 'C', stageId: stage.id });
      const moved = await h.core.deals.move(c.id, { stageId: stage.id, beforeId: a.id, afterId: b.id });
      expect(moved.position).toBeGreaterThan(a.position);
      expect(moved.position).toBeLessThan(b.position);
      await h.core.deals.move(c.id, { stageId: won.id });
      const events = await h.core.deps.db.scoped.outbox.findMany({
        where: { payload: { path: ['entityId'], equals: c.id } },
      });
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['deal.stage_changed', 'deal.won']));
      const lost = pipeline.stages.find((s) => s.kind === 'lost')!;
      await expect(h.core.deals.move(a.id, { stageId: lost.id })).rejects.toMatchObject({ status: 422 });
    });
  });

  it('invoices: totals in cents, numbering, payments and statuses', async () => {
    await inA(async () => {
      const company = await h.core.companies.create({ name: 'Billing Co' });
      const inv = await h.core.invoices.create({
        companyId: company.id,
        lines: [
          { description: 'a', quantity: 3, unitPriceCents: 333, taxRate: 20 },
          { description: 'b', quantity: 1, unitPriceCents: 1001, taxRate: 0 },
        ],
      });
      expect([inv.subtotalCents, inv.taxCents, inv.totalCents]).toEqual([2000, 200, 2200]);
      expect(inv.number).toMatch(/^INV-\d{4}-\d{4}$/);
      await expect(h.core.invoices.addPayment(inv.id, { amountCents: 100, method: 'cash' })).rejects.toMatchObject({
        status: 422,
      });
      await h.core.deps.db.scoped.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } });
      const partial = await h.core.invoices.addPayment(inv.id, { amountCents: 1000, method: 'cash' });
      expect(partial.status).toBe('partially_paid');
      await expect(h.core.invoices.addPayment(inv.id, { amountCents: 5000, method: 'cash' })).rejects.toMatchObject({
        status: 422,
      });
      const paid = await h.core.invoices.addPayment(inv.id, { amountCents: 1200, method: 'cash' });
      expect(paid.status).toBe('paid');
      expect(paid.balanceCents).toBe(0);
      await expect(h.core.invoices.void(inv.id)).rejects.toMatchObject({ status: 422 });
      const view = await h.core.invoices.publicView(paid.publicToken);
      expect(view?.balanceCents).toBe(0);
    });
  });

  it('idempotency keys replay the first response and reject a different body', async () => {
    await inA(async () => {
      let calls = 0;
      const fn = async () => ({ status: 201, body: { n: ++calls } });
      const first = await h.core.idempotency.run('test', 'key-1', { a: 1 }, fn);
      const second = await h.core.idempotency.run('test', 'key-1', { a: 1 }, fn);
      expect(first.body).toEqual({ n: 1 });
      expect(second).toMatchObject({ body: { n: 1 }, replayed: true, status: 201 });
      expect(calls).toBe(1);
      await expect(h.core.idempotency.run('test', 'key-1', { a: 2 }, fn)).rejects.toMatchObject({ status: 422 });
    });
  });

  it('comments with @mentions notify mentioned members; unknown users are rejected', async () => {
    runtime = new WorkerRuntime(h.core, { mail: false });
    await runtime.start();
    await inA(async () => {
      const company = await h.core.companies.create({ name: 'Mention Co' });
      const anna = demo.users['anna'] as string;
      await h.core.activity.addComment({
        subjectType: 'company',
        subjectId: company.id,
        body: `@[Anna Sales](${anna}) please call`,
      });
      await waitFor(
        async () => (await h.core.notifications.list(anna, true)).items.find((n) => n.kind === 'mention'),
        20_000,
      );
      await expect(
        h.core.activity.addComment({
          subjectType: 'company',
          subjectId: company.id,
          body: '@[Ghost](00000000-0000-4000-8000-000000000099) hi',
        }),
      ).rejects.toMatchObject({ status: 422 });
      const timeline = await waitFor(async () => {
        const t = await h.core.activity.timeline('company', company.id);
        return t.items.some((i) => i.kind === 'comment.created') ? t : null;
      }, 20_000);
      expect(timeline.items.map((i) => i.kind)).toContain('company.created');
    });
  });

  it('CSV import creates and merges with a progress report', async () => {
    await inA(async () => {
      const csv =
        'First Name,Last Name,Email,Company,Status\nIvy,Import,ivy@import.test,Import Co,lead\nJon,Import,jon@import.test,Import Co,customer\n,,,,\nBad,Row,not-an-email,Import Co,lead\n';
      const job = await h.core.imports.create({ entity: 'contact', fileName: 'c.csv', csv, mode: 'merge' });
      const done = await waitFor(async () => {
        const j = await h.core.imports.get(job.id);
        return j.status === 'completed' ? j : null;
      }, 30_000);
      expect(done.created).toBe(2);
      expect(done.failed).toBe(1);
      expect(done.errors[0]?.row).toBe(4);
      const again = await h.core.imports.create({
        entity: 'contact',
        fileName: 'c.csv',
        csv: 'Email,Title\nivy@import.test,CTO\n',
        mode: 'merge',
      });
      const merged = await waitFor(async () => {
        const j = await h.core.imports.get(again.id);
        return j.status === 'completed' ? j : null;
      }, 30_000);
      expect(merged.updated).toBe(1);
    });
  });

  it('merging duplicate contacts moves deals and activity to the target', async () => {
    await inA(async () => {
      const a = await h.core.contacts.create({ firstName: 'Dup', lastName: 'Person', email: 'dup1@merge.test' });
      const b = await h.core.contacts.create({ firstName: 'Dup', lastName: 'Person', phone: '+1 555 999 1234' });
      const deal = await h.core.deals.create({ title: 'Dup deal', contactId: b.id });
      const dups = await h.core.contacts.findDuplicates();
      expect(dups.some((g) => g.contacts.some((c) => c.id === a.id) && g.contacts.some((c) => c.id === b.id))).toBe(
        true,
      );
      const merged = await h.core.contacts.merge({ targetId: a.id, sourceIds: [b.id] });
      expect(merged.phone).toBe('+1 555 999 1234');
      expect((await h.core.deals.get(deal.id)).contactId).toBe(a.id);
      await expect(h.core.contacts.get(b.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('API tokens carry only scopes the role allows and authenticate as agent actors', async () => {
    const viewer = demo.users['viewer'] as string;
    await inA(async () => {
      await expect(
        h.core.accounts.createApiToken(viewer, 'viewer', { name: 'x', scopes: ['records:write'], actorType: 'user' }),
      ).rejects.toMatchObject({ status: 403 });
      const t = await h.core.accounts.createApiToken(demo.users['owner'] as string, 'owner', {
        name: 'agent',
        scopes: ['records:read', 'approvals:create'],
        actorType: 'agent',
      });
      const p = await h.core.accounts.authenticate(t.token);
      expect(p.actor.type).toBe('agent');
      expect(p.scopes.sort()).toEqual(['approvals:create', 'records:read']);
      await h.core.accounts.revokeApiToken(t.info.id);
      await expect(h.core.accounts.authenticate(t.token)).rejects.toMatchObject({ status: 401 });
    });
  });

  it('pipeline funnel is monotone and conversions never exceed 100%', async () => {
    await inA(async () => {
      const report = await h.core.reports.pipeline({});
      const open = report.stages.filter((s) => s.kind === 'open');
      for (let i = 1; i < open.length; i += 1) expect(open[i]!.reached).toBeLessThanOrEqual(open[i - 1]!.reached);
      for (const s of report.stages)
        if (s.conversionToNext !== null) expect(s.conversionToNext).toBeLessThanOrEqual(100);
      expect(open[0]!.reached).toBeGreaterThanOrEqual(report.stages.find((s) => s.kind === 'won')!.reached);
    });
  });

  it('email template preview without a record returns 422 instead of 500', async () => {
    await inA(async () => {
      await expect(
        h.core.emails.preview({ subject: 'Hi {{ invoice.number }}', body: '<p>x</p>' }),
      ).rejects.toMatchObject({ status: 422, code: 'template_error' });
      expect((await h.core.emails.preview({ subject: 'Plain', body: '<p>{{ tenant.name }}</p>' })).html).toContain(
        'Acme Corp',
      );
    });
  });

  it('CSV import reports invalid numbers instead of storing NaN', async () => {
    await inA(async () => {
      const job = await h.core.imports.create({
        entity: 'company',
        fileName: 'c.csv',
        csv: 'Name,Size\nNumeric Co,abc\n',
        mode: 'create',
      });
      const done = await waitFor(async () => {
        const j = await h.core.imports.get(job.id);
        return j.status === 'completed' ? j : null;
      }, 30_000);
      expect(done.failed).toBe(1);
      expect(done.errors[0]?.message).toMatch(/size/);
    });
  });

  it('marks overdue invoices once and the search index is rebuilt from events', async () => {
    const n = await h.core.invoices.markOverdue(new Date());
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await h.core.invoices.markOverdue(new Date())).toBe(0);
    await inA(async () => {
      const res = await h.core.search.search('Mention', ['company']);
      expect(res.groups[0]?.hits[0]?.title).toBe('Mention Co');
    });
  });
});
