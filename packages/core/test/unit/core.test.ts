import { describe, expect, it } from 'vitest';
import { T, hydrate } from '@ashamrai/expr';
import { entityType } from '@bop/workflow-core';
import { MissingTenantContextError, currentContext, requireTenantId, runInContext } from '../../src/context';
import { CrossTenantWriteError, scopeArgs } from '../../src/db/tenancy';
import { classifyError, StepError } from '../../src/engine/errors';
import { recipientsOf } from '../../src/engine/handlers';
import { DomainError } from '../../src/errors';
import { escapeHtml } from '../../src/services/invoices';
import { extractMentions } from '../../src/services/activity';
import { buildCustomSchema } from '../../src/services/custom-fields';
import { parseFilters, planList, toPage, type FieldMap } from '../../src/services/query';
import { renderHtmlTemplate } from '../../src/services/emails';
import { renderInvoiceHtml } from '../../src/pdf/invoice-html';
import { decryptSecret, encryptSecret, hashPassword, signJwt, verifyJwt, verifyPassword } from '../../src/util/crypto';
import { decodeCursor, diffObjects, encodeCursor, jsonSafe } from '../../src/util/json';
import { signPayload } from '../../src/util/webhook-signature';
import { withDatabase, databaseName } from '../../src/db/admin';
import { FakeAiProvider, OperatorAiProvider, createAiProvider } from '../../src/engine/ai';
import { loadConfig } from '../../src/config';
import { utcConnectionString } from '../../src/db/client';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('tenant scoping arguments', () => {
  it.each(['findMany', 'findFirst', 'count', 'updateMany', 'deleteMany', 'aggregate', 'groupBy'])(
    '%s adds tenantId to where',
    (op) => {
      expect(scopeArgs('Company', op, { where: { name: 'x' } }, A)).toMatchObject({
        where: { name: 'x', tenantId: A },
      });
    },
  );

  it('a foreign tenantId in where cannot widen the scope', () => {
    const args = scopeArgs('Company', 'findMany', { where: { tenantId: B } }, A);
    expect(args['where']).toEqual({ tenantId: B, AND: [{ tenantId: A }, { tenantId: B }] });
  });

  it('create stamps tenantId and rejects a different one', () => {
    expect(scopeArgs('Company', 'create', { data: { name: 'x' } }, A)).toEqual({ data: { name: 'x', tenantId: A } });
    expect(scopeArgs('Company', 'createMany', { data: [{ name: 'x' }, { name: 'y' }] }, A)['data']).toEqual([
      { name: 'x', tenantId: A },
      { name: 'y', tenantId: A },
    ]);
    expect(() => scopeArgs('Company', 'create', { data: { name: 'x', tenantId: B } }, A)).toThrow(
      CrossTenantWriteError,
    );
    expect(() => scopeArgs('Company', 'update', { where: { id: '1' }, data: { tenantId: B } }, A)).toThrow(
      CrossTenantWriteError,
    );
  });

  it('upsert scopes where and create', () => {
    expect(
      scopeArgs('Company', 'upsert', { where: { id: '1' }, create: { name: 'x' }, update: { name: 'y' } }, A),
    ).toEqual({
      where: { id: '1', tenantId: A },
      create: { name: 'x', tenantId: A },
      update: { name: 'y' },
    });
  });

  it('unknown operations fail closed', () => {
    expect(() => scopeArgs('Company', 'findRaw', {}, A)).toThrow(/not supported/);
  });

  it('context: requires a tenant, propagates through async work and lazy thenables', async () => {
    expect(() => requireTenantId()).toThrow(MissingTenantContextError);
    const lazy = { then: (resolve: (v: string | undefined) => void) => resolve(currentContext()?.tenantId) };
    const seen = await runInContext(
      { tenantId: A, actor: { type: 'system', id: null }, causation: [] },
      () => lazy as unknown as Promise<string>,
    );
    expect(seen).toBe(A);
    const nested = await runInContext({ tenantId: A, actor: { type: 'system', id: null }, causation: [] }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return requireTenantId();
    });
    expect(nested).toBe(A);
  });
});

describe('error classification for retries', () => {
  const cases: Array<[unknown, boolean, string]> = [
    [new StepError('x', true, 'http_503'), true, 'http_503'],
    [new StepError('x', false, 'http_404'), false, 'http_404'],
    [new DomainError(412, 'precondition_failed', 'changed'), true, 'precondition_failed'],
    [new DomainError(422, 'validation_failed', 'bad'), false, 'validation_failed'],
    [new DomainError(503, 'down', 'down'), true, 'down'],
    [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), true, 'network'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), true, 'timeout'],
    [new Error('db hiccup'), true, 'internal'],
  ];
  it.each(cases)('%s → retryable=%s', (error, retryable, code) => {
    const c = classifyError(error);
    expect(c.retryable).toBe(retryable);
    expect(c.code).toBe(code);
  });
});

describe('handler helpers', () => {
  it('extracts recipients from strings, users and lists', () => {
    const u = { id: '11111111-1111-4111-8111-111111111111', name: 'U', email: 'u@x.test' };
    expect(recipientsOf([u, 'a@b.c', null, ['c@d.e']])).toEqual({
      emails: ['u@x.test', 'a@b.c', 'c@d.e'],
      userIds: [u.id],
    });
    expect(recipientsOf(u.id)).toEqual({ emails: [], userIds: [u.id] });
  });

  it('fake AI provider is deterministic', async () => {
    const ai = new FakeAiProvider();
    expect((await ai.classify('please process my refund', ['upgrade', 'refund'])).label).toBe('refund');
    expect((await ai.summarize('First sentence. Second one.')).summary).toBe('First sentence.');
  });
});

describe('custom field validation', () => {
  const defs = [
    {
      id: '1',
      entity: 'deal' as const,
      key: 'region',
      label: 'Region',
      type: 'select' as const,
      options: { choices: ['EU', 'US'] },
      required: true,
      indexed: false,
      position: 0,
    },
    {
      id: '2',
      entity: 'deal' as const,
      key: 'seats',
      label: 'Seats',
      type: 'number' as const,
      options: null,
      required: false,
      indexed: false,
      position: 1,
    },
    {
      id: '3',
      entity: 'deal' as const,
      key: 'tags',
      label: 'Tags',
      type: 'multi_select' as const,
      options: { choices: ['a', 'b'] },
      required: false,
      indexed: false,
      position: 2,
    },
    {
      id: '4',
      entity: 'deal' as const,
      key: 'renewal',
      label: 'Renewal',
      type: 'date' as const,
      options: null,
      required: false,
      indexed: false,
      position: 3,
    },
  ];
  const full = buildCustomSchema(defs, false);
  const partial = buildCustomSchema(defs, true);
  it.each([
    [{ region: 'EU' }, true],
    [{ region: 'EU', seats: 5, tags: ['a'], renewal: '2026-01-31' }, true],
    [{ region: 'Mars' }, false],
    [{}, false],
    [{ region: 'EU', seats: 'five' }, false],
    [{ region: 'EU', tags: ['c'] }, false],
    [{ region: 'EU', renewal: 'tomorrow' }, false],
    [{ region: 'EU', unknown: 1 }, false],
  ])('full schema %j → %s', (value, ok) => {
    expect(full.safeParse(value).success).toBe(ok);
  });
  it('partial schema allows omitting required fields', () => {
    expect(partial.safeParse({ seats: 3 }).success).toBe(true);
  });
});

describe('list planning (filter chips, sort, cursor)', () => {
  const fields: FieldMap = {
    name: { kind: 'string', sortable: true },
    size: { kind: 'number', sortable: true, nullable: true },
    tags: { kind: 'tags' },
    createdAt: { kind: 'date', sortable: true },
  };
  it('parses chips and rejects malformed JSON', () => {
    expect(parseFilters('[{"field":"name","op":"contains","value":"acme"}]')).toHaveLength(1);
    expect(() => parseFilters('nope')).toThrow(DomainError);
    expect(() => parseFilters('[{"field":"name","op":"like"}]')).toThrow(DomainError);
  });
  it('builds a Prisma where with custom fields and keyset pagination', () => {
    const plan = planList(
      {
        limit: 2,
        filter: JSON.stringify([
          { field: 'name', op: 'contains', value: 'ac' },
          { field: 'custom.region', op: 'eq', value: 'EU' },
          { field: 'tags', op: 'in', value: ['x'] },
        ]),
        sort: '-createdAt',
      },
      fields,
      { region: 'select' },
      { deletedAt: null },
      'name',
      [],
    );
    expect(plan.where).toEqual({
      AND: [
        { deletedAt: null },
        { name: { contains: 'ac', mode: 'insensitive' } },
        { custom: { path: ['region'], equals: 'EU' } },
        { tags: { hasSome: ['x'] } },
      ],
    });
    expect(plan.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    const page = toPage(
      [
        { id: '1', createdAt: new Date('2026-01-02') },
        { id: '2', createdAt: new Date('2026-01-01') },
        { id: '3', createdAt: new Date('2025-12-31') },
      ],
      plan,
      2,
      (r) => r.id,
    );
    expect(page.items).toEqual(['1', '2']);
    const next = planList(
      { limit: 2, sort: '-createdAt', cursor: page.nextCursor ?? undefined },
      fields,
      {},
      {},
      'name',
      [],
    );
    expect(JSON.stringify(next.where)).toContain('"lt"');
  });
  it('nullable sort uses an offset cursor; unknown sort or field is rejected', () => {
    const plan = planList({ limit: 10, sort: 'size' }, fields, {}, {}, 'name', []);
    expect(plan.offset).toBe(0);
    expect(() => planList({ limit: 10, sort: 'password' }, fields, {}, {}, 'name', [])).toThrow(DomainError);
    expect(() =>
      planList({ limit: 10, filter: '[{"field":"secret","op":"eq","value":1}]' }, fields, {}, {}, 'name', []),
    ).toThrow(DomainError);
  });
  it('cursors round-trip and invalid cursors are rejected', () => {
    expect(decodeCursor(encodeCursor({ v: 3, id: 'x' }))).toEqual({ v: 3, id: 'x' });
    expect(() => decodeCursor('!!!')).toThrow(DomainError);
  });
});

describe('mentions, templates and escaping', () => {
  it('extracts unique mention ids', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(extractMentions(`hi @[Anna](${id}) and @[Anna](${id}) and @notamention`)).toEqual([id]);
  });

  it('email templates escape interpolated values in HTML but not in subjects', () => {
    const env = { vars: { contact: hydrate({ firstName: '<script>alert(1)</script>' }, T.any) } };
    expect(renderHtmlTemplate('<p>Hi {{ contact.firstName }}</p>', env, true)).toBe(
      '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(renderHtmlTemplate('Hi {{ contact.firstName }}', env, false)).toBe('Hi <script>alert(1)</script>');
    expect(() => renderHtmlTemplate('Hi {{ contact.', env, true)).toThrow(DomainError);
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('templates format money of hydrated records', () => {
    const invoice = hydrate({ number: 'INV-1', totalCents: 123456, currency: 'EUR' }, entityType('invoice'));
    expect(
      renderHtmlTemplate('{{ invoice.number }}: {{ formatMoney(invoice.totalCents) }}', { vars: { invoice } }, false),
    ).toBe('INV-1: €1,234.56');
  });

  it('invoice HTML escapes user content', () => {
    const html = renderInvoiceHtml({
      invoice: {
        id: 'i',
        number: 'INV<1>',
        status: 'paid',
        companyId: 'c',
        company: null,
        contactId: null,
        contact: null,
        dealId: null,
        currency: 'USD',
        issueDate: '2026-01-01T00:00:00Z',
        dueDate: '2026-01-15T00:00:00Z',
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
        paidCents: 1000,
        balanceCents: 0,
        notes: '<b>x</b>',
        publicToken: 't',
        publicUrl: 'u',
        sentAt: null,
        paidAt: null,
        createdByType: 'user',
        version: 1,
        createdAt: '',
        updatedAt: '',
        lines: [
          {
            id: 'l',
            position: 0,
            description: '<img src=x>',
            quantity: 1,
            unitPriceCents: 1000,
            taxRate: 0,
            amountCents: 1000,
            taxCents: 0,
          },
        ],
      },
      seller: { name: 'Acme' },
      buyer: { name: 'Buyer & Co', domain: null },
      contact: null,
    });
    expect(html).toContain('INV&lt;1&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('Buyer &amp; Co');
    expect(html).toContain('PAID');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('crypto and utilities', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('s3cret!');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('s3cret!', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('signs and verifies JWTs, rejecting tampering and expiry', () => {
    const t = signJwt({ sub: 'u1', tid: A, typ: 'access' }, 'k', 60);
    expect(verifyJwt(t, 'k')?.tid).toBe(A);
    expect(verifyJwt(t, 'other')).toBeNull();
    expect(verifyJwt(`${t.slice(0, -2)}xx`, 'k')).toBeNull();
    expect(verifyJwt(signJwt({ sub: 'u1' }, 'k', -10), 'k')).toBeNull();
  });

  it('encrypts secrets with AES-GCM and detects tampering', () => {
    const enc = encryptSecret('hook-url', 'master');
    expect(enc).not.toContain('hook-url');
    expect(decryptSecret(enc, 'master')).toBe('hook-url');
    expect(() => decryptSecret(enc, 'other')).toThrow();
  });

  it('signs webhook payloads and handles JSON-unsafe values', () => {
    expect(signPayload('{}', 'k', 1700000000)).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(jsonSafe({ a: 10n, d: new Date('2026-01-01T00:00:00Z') })).toEqual({ a: 10, d: '2026-01-01T00:00:00.000Z' });
    expect(diffObjects({ a: 1, b: 2, updatedAt: 1 }, { a: 1, b: 3, updatedAt: 2 })).toEqual({ b: { from: 2, to: 3 } });
    expect(databaseName(withDatabase('postgres://127.0.0.1:5432/postgres', 'bop_test_x'))).toBe('bop_test_x');
  });
});

describe('gap fixes: configuration and connection helpers', () => {
  it('every Prisma connection forces the UTC session time zone, replacing any other zone option', () => {
    const plain = new URL(utcConnectionString('postgres://u@127.0.0.1:5432/bop'));
    expect(plain.searchParams.get('options')).toBe('-c TimeZone=UTC');
    const mixed = new URL(
      utcConnectionString(
        'postgres://u@127.0.0.1:5432/bop?options=-c%20statement_timeout%3D5000%20-c%20TimeZone%3DEurope/Kiev',
      ),
    );
    expect(mixed.searchParams.get('options')).toBe('-c statement_timeout=5000 -c TimeZone=UTC');
  });

  it('ai_step uses the operator endpoint when OPERATOR_URL is set, the fake provider otherwise', () => {
    expect(loadConfig({}).ai.provider).toBe('fake');
    const op = loadConfig({ OPERATOR_URL: 'http://127.0.0.1:4600/ai-step', OPERATOR_TOKEN: 't' });
    expect(op.ai).toMatchObject({
      provider: 'operator',
      operatorUrl: 'http://127.0.0.1:4600/ai-step',
      operatorToken: 't',
    });
    expect(createAiProvider(op.ai)).toBeInstanceOf(OperatorAiProvider);
    expect(loadConfig({ OPERATOR_URL: 'http://x', AI_PROVIDER: 'fake' }).ai.provider).toBe('fake');
    expect(createAiProvider(loadConfig({}).ai)).toBeInstanceOf(FakeAiProvider);
  });

  it('per-tenant run creation limits default to 50/s with a burst of 500', () => {
    expect(loadConfig({}).engine).toMatchObject({ tenantRunRate: 50, tenantRunBurst: 500 });
    expect(loadConfig({ TENANT_RUN_RATE: '0' }).engine.tenantRunRate).toBe(0);
  });

  it('the operator provider maps HTTP failures to retryable and permanent step errors', async () => {
    const respond = (status: number, body: string) => async () => new Response(body, { status });
    const signal = new AbortController().signal;
    const busy = new OperatorAiProvider('http://op', null, respond(503, '{}') as typeof fetch);
    await expect(busy.summarize('x', signal)).rejects.toMatchObject({ retryable: true, code: 'operator_503' });
    const bad = new OperatorAiProvider('http://op', null, respond(400, '{}') as typeof fetch);
    await expect(bad.summarize('x', signal)).rejects.toMatchObject({ retryable: false, code: 'operator_400' });
    const junk = new OperatorAiProvider('http://op', null, respond(200, 'not json') as typeof fetch);
    await expect(junk.summarize('x', signal)).rejects.toMatchObject({ code: 'operator_invalid_response' });
    const unknownLabel = new OperatorAiProvider(
      'http://op',
      null,
      respond(200, '{"label":"other","confidence":0.9}') as typeof fetch,
    );
    expect(await unknownLabel.classify('x', ['refund'], signal)).toEqual({ label: null, summary: null, confidence: 0 });
  });
});
