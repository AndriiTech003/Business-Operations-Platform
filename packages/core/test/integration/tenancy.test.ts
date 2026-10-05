import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../../src/db/client';
import { CrossTenantWriteError, TENANT_MODELS } from '../../src/db/tenancy';
import { MissingTenantContextError, runInContext } from '../../src/context';
import { createTestResources, type TestResources } from '../../src/testing';
import { ROOT } from './helpers';

type Row = Record<string, unknown>;
type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

interface Factory {
  data(n: number, refs: Refs): Row;
  unique(row: Row): Row;
  touch: Row;
}

interface Refs {
  workflowId: string;
  runId: string;
  invoiceId: string;
  pipelineId: string;
}

const u = () => randomUUID();

const FACTORIES: Record<string, Factory> = {
  Membership: {
    data: () => ({ userId: u(), role: 'member' }),
    unique: (r) => ({ tenantId_userId: { tenantId: r['tenantId'], userId: r['userId'] } }),
    touch: { role: 'viewer' },
  },
  Company: { data: (n) => ({ name: `Co ${n}` }), unique: (r) => ({ id: r['id'] }), touch: { name: 'touched' } },
  Contact: {
    data: (n) => ({ firstName: `F${n}`, lastName: 'L' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { title: 'touched' },
  },
  Pipeline: { data: (n) => ({ name: `P${n}` }), unique: (r) => ({ id: r['id'] }), touch: { name: 'touched' } },
  Stage: {
    data: (n, refs) => ({ pipelineId: refs.pipelineId, name: `S${n}`, position: n, probability: 10 }),
    unique: (r) => ({ id: r['id'] }),
    touch: { name: 'touched' },
  },
  Deal: {
    data: (n, refs) => ({ pipelineId: refs.pipelineId, stageId: u(), title: `D${n}`, position: n }),
    unique: (r) => ({ id: r['id'] }),
    touch: { title: 'touched' },
  },
  Invoice: {
    data: (n) => ({
      number: `T-${n}-${u().slice(0, 6)}`,
      companyId: u(),
      issueDate: new Date(),
      dueDate: new Date(),
      publicToken: u(),
    }),
    unique: (r) => ({ id: r['id'] }),
    touch: { notes: 'touched' },
  },
  InvoiceLine: {
    data: (n, refs) => ({ invoiceId: refs.invoiceId, description: `L${n}`, quantity: 1, unitPriceCents: 100n }),
    unique: (r) => ({ id: r['id'] }),
    touch: { description: 'touched' },
  },
  Payment: {
    data: (_n, refs) => ({ invoiceId: refs.invoiceId, amountCents: 1n, method: 'cash', paidAt: new Date() }),
    unique: (r) => ({ id: r['id'] }),
    touch: { method: 'touched' },
  },
  Task: { data: (n) => ({ title: `T${n}` }), unique: (r) => ({ id: r['id'] }), touch: { title: 'touched' } },
  Activity: {
    data: () => ({ subjectType: 'deal', subjectId: u(), kind: 'note', actorType: 'user' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { kind: 'touched' },
  },
  Comment: {
    data: (n) => ({ subjectType: 'deal', subjectId: u(), authorId: u(), body: `c${n}` }),
    unique: (r) => ({ id: r['id'] }),
    touch: { body: 'touched' },
  },
  Notification: {
    data: () => ({ userId: u(), kind: 'k' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { kind: 'touched' },
  },
  CustomFieldDef: {
    data: (n) => ({ entity: 'company', key: `k${n}${u().slice(0, 4)}`, label: 'L', type: 'text' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { label: 'touched' },
  },
  AuditLog: {
    data: () => ({ actorType: 'user', action: 'a', entity: 'e', entityId: u() }),
    unique: (r) => ({ id: r['id'] }),
    touch: { action: 'touched' },
  },
  ApiToken: {
    data: (n) => ({ userId: u(), name: `t${n}`, prefix: 'p', tokenHash: u(), scopes: [] }),
    unique: (r) => ({ id: r['id'] }),
    touch: { name: 'touched' },
  },
  Outbox: { data: () => ({ type: 'x.y', payload: {} }), unique: (r) => ({ id: r['id'] }), touch: { type: 'touched' } },
  EmailTemplate: {
    data: (n) => ({ key: `k${n}${u().slice(0, 4)}`, name: 'n', subject: 's', body: 'b' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { name: 'touched' },
  },
  EmailMessage: {
    data: () => ({ toAddresses: ['a@b.c'], subject: 's', html: 'h', status: 'draft' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { subject: 'touched' },
  },
  Secret: {
    data: (n) => ({ name: `s${n}${u().slice(0, 4)}`, ciphertext: 'x' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { ciphertext: 'touched' },
  },
  ImportJob: {
    data: () => ({ entity: 'company', fileName: 'f.csv', csv: 'name\nA' }),
    unique: (r) => ({ id: r['id'] }),
    touch: { status: 'touched' },
  },
  SearchDocument: {
    data: (n) => ({ entity: 'company', entityId: u(), title: `doc ${n}` }),
    unique: (r) => ({
      tenantId_entity_entityId: { tenantId: r['tenantId'], entity: r['entity'], entityId: r['entityId'] },
    }),
    touch: { title: 'touched' },
  },
  IdempotencyRecord: {
    data: (n) => ({ key: `k${n}${u()}`, scope: 's', requestHash: 'h', statusCode: 200, response: {} }),
    unique: (r) => ({ tenantId_scope_key: { tenantId: r['tenantId'], scope: r['scope'], key: r['key'] } }),
    touch: { statusCode: 201 },
  },
  Workflow: {
    data: (n) => ({ name: `W${n}`, webhookSecret: u() }),
    unique: (r) => ({ id: r['id'] }),
    touch: { name: 'touched' },
  },
  WorkflowVersion: {
    data: (n, refs) => ({ workflowId: refs.workflowId, version: 1000 + n, definition: {}, checksum: 'c' }),
    unique: (r) => ({ workflowId_version: { workflowId: r['workflowId'], version: r['version'] } }),
    touch: { checksum: 'touched' },
  },
  WorkflowDraft: {
    data: () => ({ workflowId: u(), definition: {} }),
    unique: (r) => ({ workflowId: r['workflowId'] }),
    touch: { definition: { touched: true } },
  },
  WorkflowRun: {
    data: () => ({ workflowId: u(), version: 1, status: 'running', triggerType: 'manual', triggerPayload: {} }),
    unique: (r) => ({ id: r['id'] }),
    touch: { status: 'waiting' },
  },
  StepRun: {
    data: (n, refs) => ({
      runId: refs.runId,
      nodeId: `n${n}${u().slice(0, 4)}`,
      nodeType: 'end',
      status: 'pending',
      idempotencyKey: u(),
    }),
    unique: (r) => ({ id: r['id'] }),
    touch: { status: 'waiting' },
  },
  Approval: {
    data: (n) => ({ source: 'agent', title: `A${n}` }),
    unique: (r) => ({ id: r['id'] }),
    touch: { title: 'touched' },
  },
  EffectLog: {
    data: () => ({ idempotencyKey: u(), effect: 'e', result: {} }),
    unique: (r) => ({
      tenantId_origin_idempotencyKey: {
        tenantId: r['tenantId'],
        origin: r['origin'],
        idempotencyKey: r['idempotencyKey'],
      },
    }),
    touch: { effect: 'touched' },
  },
};

const OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;

let res: TestResources;
let db: Db;
const tenantA = randomUUID();
const tenantB = randomUUID();
const refs: Record<string, Refs> = {};
let counter = 0;

const lower = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
const delegate = (m: string): Delegate => (db.scoped as unknown as Record<string, Delegate>)[lower(m)] as Delegate;
const asTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  runInContext({ tenantId, actor: { type: 'system', id: null }, causation: [] }, fn);

async function make(model: string, tenantId: string): Promise<Row> {
  counter += 1;
  const f = FACTORIES[model] as Factory;
  return asTenant(
    tenantId,
    () => delegate(model)['create']!({ data: f.data(counter, refs[tenantId] as Refs) }) as Promise<Row>,
  );
}

function argsFor(op: (typeof OPERATIONS)[number], model: string, target: Row): unknown {
  const f = FACTORIES[model] as Factory;
  counter += 1;
  switch (op) {
    case 'findUnique':
    case 'findUniqueOrThrow':
      return { where: f.unique(target) };
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'findMany':
      return { where: {} };
    case 'count':
      return {};
    case 'aggregate':
      return { _count: true };
    case 'groupBy':
      return { by: ['tenantId'], _count: true };
    case 'create':
      return { data: f.data(counter, refs[tenantA] as Refs) };
    case 'createMany':
    case 'createManyAndReturn':
      return { data: [f.data(counter, refs[tenantA] as Refs)] };
    case 'update':
      return { where: f.unique(target), data: f.touch };
    case 'updateMany':
    case 'updateManyAndReturn':
      return { where: {}, data: f.touch };
    case 'upsert':
      return { where: f.unique(target), create: f.data(counter, refs[tenantA] as Refs), update: f.touch };
    case 'delete':
      return { where: f.unique(target) };
    case 'deleteMany':
      return { where: { tenantId: tenantB } };
  }
}

function schemaTenantModels(): string[] {
  const schema = readFileSync(resolve(ROOT, 'packages/core/prisma/schema.prisma'), 'utf8');
  const out: string[] = [];
  for (const m of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g))
    if (/\n\s+tenantId\s/.test(m[2] ?? '')) out.push(m[1] as string);
  return out.sort();
}

beforeAll(async () => {
  res = await createTestResources('tenancy');
  db = new Db(res.databaseUrl, 4);
  for (const t of [tenantA, tenantB]) {
    await db.system.tenant.create({ data: { id: t, slug: `t-${t.slice(0, 8)}`, name: t } });
    const r = await asTenant(t, async () => {
      const wf = (await delegate('Workflow')['create']!({ data: { name: 'ref', webhookSecret: u() } })) as Row;
      const run = (await delegate('WorkflowRun')['create']!({
        data: { workflowId: wf['id'], version: 1, status: 'running', triggerType: 'manual', triggerPayload: {} },
      })) as Row;
      const inv = (await delegate('Invoice')['create']!({
        data: { number: `REF-${t}`, companyId: u(), issueDate: new Date(), dueDate: new Date(), publicToken: u() },
      })) as Row;
      const p = (await delegate('Pipeline')['create']!({ data: { name: 'ref' } })) as Row;
      return {
        workflowId: wf['id'] as string,
        runId: run['id'] as string,
        invoiceId: inv['id'] as string,
        pipelineId: p['id'] as string,
      };
    });
    refs[t] = r;
  }
});

afterAll(async () => {
  await db?.close();
  await res?.drop();
});

describe('tenant scoping Prisma extension', () => {
  it('covers exactly the models that have a tenantId column', () => {
    expect([...TENANT_MODELS].sort()).toEqual(schemaTenantModels());
    expect(Object.keys(FACTORIES).sort()).toEqual(schemaTenantModels());
  });

  const cases = [...TENANT_MODELS].flatMap((model) => OPERATIONS.map((op) => [model, op] as const));

  it.each(cases)('%s.%s throws without a tenant context', async (model, op) => {
    const target = await make(model, tenantB);
    const call = delegate(model)[op];
    expect(call).toBeTypeOf('function');
    await expect(call!(argsFor(op, model, target))).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it.each(cases)('%s.%s in tenant A never reads or changes tenant B data', async (model, op) => {
    const ownB = await make(model, tenantB);
    await make(model, tenantA);
    const call = delegate(model)[op]!;
    const result = await asTenant(tenantA, async () => {
      try {
        return { ok: true as const, value: await call(argsFor(op, model, ownB)) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    const bRows = (await asTenant(tenantB, () => delegate(model)['findMany']!({ where: {} }))) as Row[];
    const stillThere = bRows.find(
      (r) => JSON.stringify(FACTORIES[model]!.unique(r)) === JSON.stringify(FACTORIES[model]!.unique(ownB)),
    );
    expect(stillThere, 'tenant B row must survive').toBeDefined();
    for (const [k, v] of Object.entries(FACTORIES[model]!.touch))
      expect(JSON.stringify(stillThere?.[k])).not.toBe(JSON.stringify(v));
    const values = !result.ok
      ? []
      : Array.isArray(result.value)
        ? (result.value as Row[])
        : result.value !== null && typeof result.value === 'object'
          ? [result.value as Row]
          : [];
    switch (op) {
      case 'findUnique':
        expect(result.ok && result.value).toBeNull();
        break;
      case 'findUniqueOrThrow':
      case 'update':
      case 'delete':
        expect(result.ok).toBe(false);
        break;
      case 'count': {
        const own = (await asTenant(tenantA, () => delegate(model)['findMany']!({ where: {} }))) as Row[];
        expect(result.ok && result.value).toBe(own.length);
        break;
      }
      case 'groupBy':
        expect(values.every((g) => g['tenantId'] === tenantA)).toBe(true);
        break;
      case 'aggregate':
        expect(result.ok).toBe(true);
        break;
      case 'deleteMany':
        expect(result.ok && (result.value as { count: number }).count).toBe(0);
        break;
      case 'upsert':
        if (result.ok) expect((result.value as Row)['tenantId']).toBe(tenantA);
        break;
      default:
        if (result.ok) for (const v of values) if ('tenantId' in v) expect(v['tenantId']).toBe(tenantA);
    }
  });

  it.each([...TENANT_MODELS])('%s.create stamps the current tenant and refuses a foreign tenantId', async (model) => {
    const f = FACTORIES[model] as Factory;
    counter += 1;
    const created = (await asTenant(tenantA, () =>
      delegate(model)['create']!({ data: f.data(counter, refs[tenantA] as Refs) }),
    )) as Row;
    expect(created['tenantId']).toBe(tenantA);
    counter += 1;
    await expect(
      asTenant(tenantA, () =>
        delegate(model)['create']!({ data: { ...f.data(counter, refs[tenantA] as Refs), tenantId: tenantB } }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(
      asTenant(tenantA, () =>
        delegate(model)['createMany']!({
          data: [{ ...f.data(counter + 1, refs[tenantA] as Refs), tenantId: tenantB }],
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });

  it('interactive transactions keep the scope', async () => {
    const b = await make('Company', tenantB);
    const seen = await asTenant(tenantA, () =>
      db.scoped.$transaction(async (tx) => tx.company.findMany({ where: { id: b['id'] as string } })),
    );
    expect(seen).toHaveLength(0);
    await expect(db.scoped.$transaction(async (tx) => tx.company.count())).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('global models are not scoped', async () => {
    const count = await db.scoped.tenant.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
