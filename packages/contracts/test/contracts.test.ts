import { describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  companyUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  customFieldUpdateSchema,
  dealUpdateSchema,
  invoiceUpdateSchema,
  patchSchema,
  taskUpdateSchema,
  workflowNodeSchema,
  ROLE_SCOPES,
  SCOPES,
  dealMoveSchema,
  formatCents,
  fractionalPosition,
  invoiceCreateSchema,
  invoiceTotals,
  lineTotals,
  workflowDefinitionSchema,
} from '../src';

describe('money', () => {
  it.each([
    [1, 1000, 0, 1000, 0],
    [3, 333, 20, 999, 200],
    [1.5, 1999, 7.5, 2999, 225],
    [0.333, 100, 0, 33, 0],
  ])('line %d × %d @ %d%% → amount %d tax %d', (q, unit, rate, amount, tax) => {
    expect(lineTotals(q, unit, rate)).toEqual({ amountCents: amount, taxCents: tax });
  });

  it('sums integer cents', () => {
    expect(
      invoiceTotals([
        { quantity: 2, unitPriceCents: 1050, taxRate: 20 },
        { quantity: 1, unitPriceCents: 999, taxRate: 0 },
      ]),
    ).toEqual({ subtotalCents: 3099, taxCents: 420, totalCents: 3519 });
    expect(formatCents(123456, 'USD')).toBe('$1,234.56');
  });

  it('fractional positions fit between neighbours', () => {
    expect(fractionalPosition(null, null)).toBe(1024);
    expect(fractionalPosition(1024, null)).toBe(2048);
    expect(fractionalPosition(null, 1024)).toBe(0);
    const mid = fractionalPosition(1024, 2048);
    expect(mid).toBeGreaterThan(1024);
    expect(mid).toBeLessThan(2048);
  });
});

describe('schemas', () => {
  it('invoice input defaults and validation', () => {
    const v = invoiceCreateSchema.parse({ companyId: '7f1b2c3d-1111-4222-8333-444455556666' });
    expect(v.currency).toBe('USD');
    expect(v.lines).toEqual([]);
    expect(invoiceCreateSchema.safeParse({ companyId: 'x' }).success).toBe(false);
    expect(
      invoiceCreateSchema.safeParse({
        companyId: '7f1b2c3d-1111-4222-8333-444455556666',
        lines: [{ description: 'a', quantity: 1, unitPriceCents: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('deal move and workflow definitions', () => {
    expect(dealMoveSchema.safeParse({ stageId: '7f1b2c3d-1111-4222-8333-444455556666', beforeId: null }).success).toBe(
      true,
    );
    expect(
      workflowDefinitionSchema.safeParse({
        name: 'x',
        trigger: { type: 'manual' },
        nodes: [{ id: 'bad id', type: 'end' }],
        edges: [],
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        name: 'x',
        trigger: { type: 'schedule', cron: '0 9 * * 1' },
        nodes: [{ id: 'e', type: 'end' }],
        edges: [],
      }).success,
    ).toBe(true);
  });
});

describe('route table and roles', () => {
  it('every route has a unique method + path, a tag and either auth or a scope', () => {
    const keys = API_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of API_ROUTES) {
      expect(r.tag.length).toBeGreaterThan(0);
      expect(r.auth !== undefined || r.scope !== undefined).toBe(true);
    }
    expect(
      API_ROUTES.filter((r) => r.idempotent)
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      '/v1/deals/:id',
      '/v1/deals/:id/move',
      '/v1/emails/:id/send',
      '/v1/emails/drafts',
      '/v1/invoices',
      '/v1/invoices/:id/payments',
      '/v1/invoices/:id/send',
      '/v1/invoices/:id/void',
      '/v1/notes',
      '/v1/tasks',
    ]);
  });

  it('roles are nested: viewer ⊂ member ⊂ manager ⊂ admin = owner', () => {
    const sub = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));
    expect(sub(ROLE_SCOPES.viewer, ROLE_SCOPES.member)).toBe(true);
    expect(sub(ROLE_SCOPES.member, ROLE_SCOPES.manager)).toBe(true);
    expect(sub(ROLE_SCOPES.manager, ROLE_SCOPES.admin)).toBe(true);
    expect([...ROLE_SCOPES.owner].sort()).toEqual([...SCOPES].sort());
    expect(ROLE_SCOPES.viewer).not.toContain('records:write');
    expect(ROLE_SCOPES.member).not.toContain('approvals:decide');
  });
});

describe('PATCH schemas only carry the fields that were sent', () => {
  it.each([
    ['contact', contactUpdateSchema, { firstName: 'Ann' }],
    ['company', companyUpdateSchema, { name: 'Acme' }],
    ['deal', dealUpdateSchema, { title: 'Renewal' }],
    ['invoice', invoiceUpdateSchema, { notes: 'Thanks' }],
    ['task', taskUpdateSchema, { status: 'done' }],
    ['custom field', customFieldUpdateSchema, { label: 'Region' }],
  ] as const)('%s update keeps omitted fields undefined', (_name, schema, body) => {
    expect(schema.parse(body)).toEqual(body);
    expect(schema.parse({})).toEqual({});
  });

  it('still validates the provided fields and keeps explicit nulls', () => {
    expect(contactUpdateSchema.safeParse({ lastName: 'x'.repeat(101) }).success).toBe(false);
    expect(contactUpdateSchema.parse({ lastName: '', email: null })).toEqual({ lastName: '', email: null });
    expect(dealUpdateSchema.parse({ amountCents: 5, lostReason: null })).toEqual({ amountCents: 5, lostReason: null });
  });

  it('create schemas keep their defaults', () => {
    expect(contactCreateSchema.parse({ firstName: 'Ann' }).lastName).toBe('');
  });

  it('node retry overrides do not reset the registry defaults', () => {
    expect(workflowNodeSchema.parse({ id: 'a', type: 'http_request', retry: { maxAttempts: 7 } }).retry).toEqual({
      maxAttempts: 7,
    });
  });

  it('patchSchema strips defaults from any object schema', () => {
    const s = patchSchema(contactCreateSchema);
    expect(Object.keys(s.parse({ tags: ['a'] }))).toEqual(['tags']);
  });
});
