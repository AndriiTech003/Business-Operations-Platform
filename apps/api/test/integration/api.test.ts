import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES } from '@bop/contracts';
import { loadConfig, seedDemo, type SeedResult } from '@bop/core';
import { createTestResources, testEnv, type TestResources } from '@bop/core/testing';
import { CONTROLLERS, createApi, type RunningApi } from '../../src/app';

let res: TestResources;
let api: RunningApi;
let demo: SeedResult;
let owner = '';
let viewer = '';
let otherToken = '';

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const r = await fetch(`${api.url}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return {
    status: r.status,
    headers: r.headers,
    json: json as Record<string, unknown> & { items?: Array<Record<string, unknown>> },
  };
}

async function login(email: string): Promise<{ token: string; cookie: string }> {
  const r = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  const body = (await r.json()) as { accessToken: string };
  return { token: body.accessToken, cookie: r.headers.get('set-cookie') ?? '' };
}

beforeAll(async () => {
  res = await createTestResources('api');
  const env = testEnv(res, { PUBLIC_API_URL: 'http://127.0.0.1:4593' });
  api = await createApi({
    port: 0,
    host: '127.0.0.1',
    config: loadConfig({ ...process.env, ...env, REALTIME_URL: '' }),
  });
  demo = await seedDemo(api.core, { slug: `api-${res.id}`, workflows: true });
  owner = (await login('demo@demo.dev')).token;
  viewer = (await login('viewer@demo.dev')).token;
  otherToken = (await login('owner@globex.dev')).token;
});

afterAll(async () => {
  await api?.close();
  await res?.drop();
});

describe('route table', () => {
  it('every controller route is documented in API_ROUTES and vice versa', () => {
    const methods: Record<number, string> = {
      [RequestMethod.GET]: 'GET',
      [RequestMethod.POST]: 'POST',
      [RequestMethod.PUT]: 'PUT',
      [RequestMethod.PATCH]: 'PATCH',
      [RequestMethod.DELETE]: 'DELETE',
    };
    const implemented: string[] = [];
    for (const controller of CONTROLLERS) {
      const proto = controller.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata('path', handler) as string | undefined;
        const method = Reflect.getMetadata('method', handler) as number | undefined;
        if (path === undefined || method === undefined) continue;
        implemented.push(`${methods[method]} ${path}`);
      }
    }
    const documented = API_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(implemented.sort()).toEqual([...documented].sort());
  });

  it('serves OpenAPI 3.1 with every path and a self-contained docs page', async () => {
    const doc = await call('GET', '/openapi.json');
    expect(doc.json['openapi']).toBe('3.1.0');
    expect(Object.keys(doc.json['paths'] as object)).toContain('/v1/deals/{id}/move');
    const docs = await fetch(`${api.url}/docs`);
    const html = await docs.text();
    expect(html).toContain('/openapi.json');
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});

describe('auth, scopes and problem+json', () => {
  it('rejects anonymous requests with problem+json', async () => {
    const r = await call('GET', '/v1/companies');
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.json).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('refresh cookie issues a new access token', async () => {
    const { cookie } = await login('demo@demo.dev');
    const r = await fetch(`${api.url}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { accessToken: string }).accessToken.split('.')).toHaveLength(3);
  });

  it('viewers can read but not write (insufficient_scope)', async () => {
    expect((await call('GET', '/v1/companies?limit=5', { token: viewer })).status).toBe(200);
    const w = await call('POST', '/v1/companies', { token: viewer, body: { name: 'Nope' } });
    expect(w.status).toBe(403);
    expect(w.json).toMatchObject({ code: 'insufficient_scope', required: 'records:write' });
  });

  it('malformed ids are a 400 problem, not a 500', async () => {
    const r = await call('GET', '/v1/deals/not-a-uuid', { token: owner });
    expect(r.status).toBe(400);
    expect(r.json['code']).toBe('invalid_id');
  });

  it('validation errors list the failing paths', async () => {
    const r = await call('POST', '/v1/deals', { token: owner, body: { title: '', amountCents: -1 } });
    expect(r.status).toBe(400);
    expect((r.json['errors'] as Array<{ path: string }>).map((e) => e.path).sort()).toEqual(['amountCents', 'title']);
  });

  it('another tenant’s user cannot see or change records (404, not leak)', async () => {
    const list = await call('GET', '/v1/companies?limit=1', { token: owner });
    const id = (list.json.items?.[0] as { id: string }).id;
    expect((await call('GET', `/v1/companies/${id}`, { token: otherToken })).status).toBe(404);
    expect((await call('PATCH', `/v1/companies/${id}`, { token: otherToken, body: { name: 'hijack' } })).status).toBe(
      404,
    );
    const search = await call('GET', '/v1/search?q=Northwind', { token: otherToken });
    expect(search.json['groups']).toEqual([]);
  });
});

describe('records over HTTP', () => {
  it('lists with filter chips, sort by custom field and cursor pagination', async () => {
    const filter = encodeURIComponent(JSON.stringify([{ field: 'custom.region', op: 'eq', value: 'EMEA' }]));
    const r = await call('GET', `/v1/companies?limit=3&filter=${filter}&sort=name`, { token: owner });
    expect(r.status).toBe(200);
    expect(r.json.items?.every((c) => (c['custom'] as { region: string }).region === 'EMEA')).toBe(true);
    const next = await call(
      'GET',
      `/v1/companies?limit=3&filter=${filter}&sort=name&cursor=${encodeURIComponent(String(r.json['nextCursor']))}`,
      { token: owner },
    );
    expect(next.json.items?.[0]?.['name']).not.toBe(r.json.items?.[0]?.['name']);
    const sorted = await call('GET', '/v1/companies?limit=50&sort=-custom.region', { token: owner });
    const regions = sorted.json.items?.map((c) => (c['custom'] as { region?: string }).region ?? '');
    expect(regions?.[0]).toBe('NA');
  });

  it('ETag + If-Match → 412 with the current record', async () => {
    const created = await call('POST', '/v1/companies', { token: owner, body: { name: 'Etag Co' } });
    const id = created.json['id'] as string;
    const got = await call('GET', `/v1/companies/${id}`, { token: owner });
    const etag = got.headers.get('etag') ?? '';
    expect(etag).toBe('W/"1"');
    expect(
      (
        await call('PATCH', `/v1/companies/${id}`, {
          token: owner,
          body: { industry: 'A' },
          headers: { 'if-match': etag },
        })
      ).status,
    ).toBe(200);
    const stale = await call('PATCH', `/v1/companies/${id}`, {
      token: owner,
      body: { industry: 'B' },
      headers: { 'if-match': etag },
    });
    expect(stale.status).toBe(412);
    expect((stale.json['current'] as { industry: string }).industry).toBe('A');
  });

  it('Idempotency-Key on invoice creation replays the first response', async () => {
    const company = (await call('GET', '/v1/companies?limit=1', { token: owner })).json.items?.[0]?.['id'];
    const body = {
      companyId: company,
      lines: [{ description: 'Idem', quantity: 1, unitPriceCents: 5000, taxRate: 0 }],
    };
    const a = await call('POST', '/v1/invoices', {
      token: owner,
      body,
      headers: { 'idempotency-key': `inv-${res.id}` },
    });
    const b = await call('POST', '/v1/invoices', {
      token: owner,
      body,
      headers: { 'idempotency-key': `inv-${res.id}` },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json['id']).toBe(a.json['id']);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await call('POST', '/v1/invoices', {
      token: owner,
      body: { ...body, notes: 'different' },
      headers: { 'idempotency-key': `inv-${res.id}` },
    });
    expect(c.status).toBe(422);
    const effects = await api.core.deps.db.system.effectLog.findMany({ where: { idempotencyKey: `inv-${res.id}` } });
    expect(effects.map((e) => [e.origin, e.effect, (e.result as { ref: { id: string } }).ref.id])).toEqual([
      ['api', 'invoice.create', a.json['id']],
    ]);
    const reused = await call('POST', '/v1/tasks', {
      token: owner,
      body: { title: 'same key, other operation' },
      headers: { 'idempotency-key': `inv-${res.id}` },
    });
    expect(reused.status).toBe(422);
    expect(reused.json['code']).toBe('idempotency_mismatch');
  });

  it('PATCH changes only the fields that were sent (every PATCH endpoint)', async () => {
    const contact = await call('POST', '/v1/contacts', {
      token: owner,
      body: { firstName: 'Patch', lastName: 'Keeper', title: 'CTO', tags: ['vip'] },
    });
    const c1 = await call('PATCH', `/v1/contacts/${String(contact.json['id'])}`, {
      token: owner,
      body: { firstName: 'Patricia' },
    });
    expect(c1.status).toBe(200);
    expect(c1.json).toMatchObject({ firstName: 'Patricia', lastName: 'Keeper', title: 'CTO', tags: ['vip'] });
    const c2 = await call('PATCH', `/v1/contacts/${String(contact.json['id'])}`, {
      token: owner,
      body: { lastName: '' },
    });
    expect(c2.json).toMatchObject({ firstName: 'Patricia', lastName: '' });

    const company = await call('POST', '/v1/companies', {
      token: owner,
      body: { name: 'Patchy Co', domain: 'patchy.test', tags: ['a'] },
    });
    const k = await call('PATCH', `/v1/companies/${String(company.json['id'])}`, {
      token: owner,
      body: { industry: 'Retail' },
    });
    expect(k.json).toMatchObject({ name: 'Patchy Co', domain: 'patchy.test', industry: 'Retail', tags: ['a'] });

    const deal = await call('POST', '/v1/deals', {
      token: owner,
      body: { title: 'Patch deal', amountCents: 123_400, currency: 'EUR' },
    });
    const d = await call('PATCH', `/v1/deals/${String(deal.json['id'])}`, { token: owner, body: { title: 'Renamed' } });
    expect(d.json).toMatchObject({ title: 'Renamed', amountCents: 123_400, currency: 'EUR' });

    const task = await call('POST', '/v1/tasks', { token: owner, body: { title: 'Patch task', priority: 4 } });
    const t = await call('PATCH', `/v1/tasks/${String(task.json['id'])}`, { token: owner, body: { status: 'done' } });
    expect(t.json).toMatchObject({ status: 'done', priority: 4, title: 'Patch task' });

    const invoice = await call('POST', '/v1/invoices', {
      token: owner,
      body: {
        companyId: company.json['id'],
        currency: 'EUR',
        lines: [{ description: 'Keep me', quantity: 2, unitPriceCents: 1000, taxRate: 0 }],
      },
    });
    const i = await call('PATCH', `/v1/invoices/${String(invoice.json['id'])}`, {
      token: owner,
      body: { notes: 'Thanks!' },
    });
    expect(i.status).toBe(200);
    expect(i.json).toMatchObject({ notes: 'Thanks!', currency: 'EUR', totalCents: 2000 });
    expect((i.json['lines'] as unknown[] | undefined)?.length ?? 1).toBe(1);

    const field = await call('POST', '/v1/custom-fields', {
      token: owner,
      body: {
        entity: 'deal',
        key: `patch${res.id.replace(/[^a-z0-9]/gi, '')}`,
        label: 'P',
        type: 'text',
        required: true,
      },
    });
    const f = await call('PATCH', `/v1/custom-fields/${String(field.json['id'])}`, {
      token: owner,
      body: { label: 'Renamed field' },
    });
    expect(f.json).toMatchObject({ label: 'Renamed field', required: true });
    const f2 = await call('PATCH', `/v1/custom-fields/${String(field.json['id'])}`, {
      token: owner,
      body: { required: false },
    });
    expect(f2.json).toMatchObject({ label: 'Renamed field', required: false });

    const wf = await call('POST', '/v1/workflows', { token: owner, body: { name: 'Patch wf', description: 'keep' } });
    const w = await call('PATCH', `/v1/workflows/${String(wf.json['id'])}`, {
      token: owner,
      body: { name: 'Renamed wf' },
    });
    expect(w.json).toMatchObject({ name: 'Renamed wf', description: 'keep' });

    const before = (await call('GET', '/v1/me', { token: owner })).json['tenant'] as {
      settings: Record<string, unknown>;
    };
    const st = await call('PATCH', '/v1/settings', { token: owner, body: { invoicePrefix: 'PT' } });
    expect(st.json).toMatchObject({ ...before.settings, invoicePrefix: 'PT' });
    await call('PATCH', '/v1/settings', { token: owner, body: { invoicePrefix: before.settings['invoicePrefix'] } });
  });

  it('moving a lost deal within its stage updates the lost reason', async () => {
    const pipelines = (await call('GET', '/v1/pipelines', { token: owner })).json as unknown as Array<{
      stages: Array<{ id: string; kind: string }>;
    }>;
    const lost = pipelines[0]!.stages.find((st) => st.kind === 'lost')!.id;
    const deal = await call('POST', '/v1/deals', { token: owner, body: { title: 'Lost twice' } });
    expect(deal.status, JSON.stringify(deal.json)).toBe(201);
    const id = String(deal.json['id']);
    await call('PATCH', `/v1/deals/${id}/move`, { token: owner, body: { stageId: lost, lostReason: 'Price' } });
    const again = await call('PATCH', `/v1/deals/${id}/move`, {
      token: owner,
      body: { stageId: lost, lostReason: 'Timing' },
    });
    expect(again.status).toBe(200);
    expect(again.json['lostReason']).toBe('Timing');
  });

  it('run creation beyond the tenant rate limit is a 429 problem with Retry-After', async () => {
    const ownerId = await api.core.accounts.createUser(`rl-${res.id}@test.dev`, 'Rate Limited', 'demo1234');
    await api.core.accounts.createTenant({
      slug: `rl-${res.id}`,
      name: 'Rate limited',
      ownerId,
      settings: { runsPerSecond: 0.2, runBurst: 1 },
    });
    const token = (await login(`rl-${res.id}@test.dev`)).token;
    const wf = await call('POST', '/v1/workflows', {
      token,
      body: {
        name: 'rl',
        definition: {
          name: 'rl',
          trigger: { type: 'manual' },
          nodes: [{ id: 'done', type: 'end', config: {} }],
          edges: [{ from: '$trigger', to: 'done' }],
        },
      },
    });
    const id = String(wf.json['id']);
    expect((await call('POST', `/v1/workflows/${id}/publish`, { token, body: {} })).status).toBeLessThan(300);
    const first = await call('POST', `/v1/workflows/${id}/runs`, { token, body: {} });
    expect(first.status).toBeLessThan(300);
    const second = await call('POST', `/v1/workflows/${id}/runs`, { token, body: {} });
    expect(second.status).toBe(429);
    expect(second.json['code']).toBe('run_rate_limited');
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(second.json['retryAfterMs'])).toBeGreaterThan(1000);
  });

  it('app-config exposes the operator panel only when configured', async () => {
    const off = await call('GET', '/v1/app-config');
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ operator: null });
    const env = testEnv(res, { PUBLIC_API_URL: 'http://127.0.0.1:4593' });
    const withOperator = await createApi({
      port: 0,
      host: '127.0.0.1',
      config: loadConfig({
        ...process.env,
        ...env,
        REALTIME_URL: '',
        OPERATOR_EMBED_URL: 'http://127.0.0.1:4611/embed/ask-operator.js',
        OPERATOR_AGENT_URL: 'http://127.0.0.1:4600',
      }),
    });
    try {
      const on = await fetch(`${withOperator.url}/v1/app-config`);
      expect(await on.json()).toEqual({
        operator: {
          scriptUrl: 'http://127.0.0.1:4611/embed/ask-operator.js',
          agentUrl: 'http://127.0.0.1:4600',
          consoleUrl: null,
        },
      });
    } finally {
      await withOperator.close();
    }
  });

  it('public invoice page needs no auth and hides drafts', async () => {
    const list = await call(
      'GET',
      `/v1/invoices?limit=50&filter=${encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'partially_paid' }]))}`,
      { token: owner },
    );
    const inv = list.json.items?.[0] as { publicToken: string; number: string };
    const pub = await call('GET', `/p/invoices/${inv.publicToken}`);
    expect(pub.status).toBe(200);
    expect(pub.json['number']).toBe(inv.number);
    const paid = await call('POST', `/p/invoices/${inv.publicToken}/pay`);
    expect(paid.json['status']).toBe('paid');
    expect((await call('GET', '/p/invoices/does-not-exist')).status).toBe(404);
  });

  it('reports, forecast, board and timeline respond', async () => {
    for (const p of [
      '/v1/reports/pipeline',
      '/v1/reports/revenue',
      '/v1/reports/ar-aging',
      '/v1/reports/activity',
      '/v1/deals/forecast',
      '/v1/deals/board',
      '/v1/approvals/count',
      '/v1/workflows',
      '/v1/workflows/templates',
      '/v1/custom-fields',
      '/v1/members',
    ]) {
      const r = await call('GET', p, { token: owner });
      expect(r.status, p).toBe(200);
    }
    const aging = await call('GET', '/v1/reports/ar-aging', { token: owner });
    expect((aging.json['buckets'] as unknown[]).length).toBe(4);
  });

  it('workflow draft autosave validates, diff and publish create an immutable version', async () => {
    const wf = await call('POST', '/v1/workflows', {
      token: owner,
      body: { name: 'HTTP wf', templateKey: 'overdue_invoice' },
    });
    const id = wf.json['id'] as string;
    const draft = (wf.json['draft'] as { definition: Record<string, unknown> }).definition;
    const bad = await call('PUT', `/v1/workflows/${id}/draft`, {
      token: owner,
      body: {
        definition: {
          ...draft,
          nodes: [
            ...(draft['nodes'] as unknown[]),
            { id: 'oops', type: 'condition', config: { expr: 'invoice.nope' } },
          ],
        },
      },
    });
    expect((bad.json['issues'] as Array<{ code: string }>).map((i) => i.code)).toContain('unknown_field');
    expect((await call('POST', `/v1/workflows/${id}/publish`, { token: owner })).status).toBe(422);
    expect((await call('PUT', `/v1/workflows/${id}/draft`, { token: owner, body: { definition: draft } })).status).toBe(
      200,
    );
    const diff = await call('GET', `/v1/workflows/${id}/diff`, { token: owner });
    expect((diff.json['addedNodes'] as string[]).length).toBe(7);
    const pub = await call('POST', `/v1/workflows/${id}/publish`, { token: owner });
    expect(pub.json['activeVersion']).toBe(1);
    expect((await call('GET', `/v1/workflows/${id}/versions/1`, { token: owner })).json['version']).toBe(1);
  });

  it('external approvals require approvals:create and are decided by managers', async () => {
    const created = await call('POST', '/v1/approvals', {
      token: owner,
      body: { title: 'Agent: send final notice', assigneeRole: 'manager', details: { invoice: 'INV-1' } },
    });
    expect(created.status).toBe(201);
    const id = created.json['id'] as string;
    expect(
      (await call('POST', `/v1/approvals/${id}/decide`, { token: viewer, body: { decision: 'approve' } })).status,
    ).toBe(403);
    const manager = (await login('manager@demo.dev')).token;
    const decided = await call('POST', `/v1/approvals/${id}/decide`, {
      token: manager,
      body: { decision: 'approve', comment: 'ok' },
    });
    expect(decided.json['status']).toBe('approved');
    expect(
      (await call('POST', `/v1/approvals/${id}/decide`, { token: manager, body: { decision: 'reject' } })).status,
    ).toBe(409);
  });

  it('health and metrics', async () => {
    expect((await call('GET', '/health')).json).toMatchObject({ status: 'ok' });
    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toContain('http_request_duration_seconds');
    expect(metrics).toContain('workflow_runs_total');
  });

  it('seed counts match the demo dataset', () => {
    expect(demo.counts).toMatchObject({ companies: 20, contacts: 48, deals: 36, invoices: 16, workflows: 6 });
  });
});
