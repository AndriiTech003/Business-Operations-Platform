import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, runInContext, seedDemo, type SeedResult } from '@bop/core';
import { createTestResources, testEnv, type TestResources } from '@bop/core/testing';
import { createApi, type RunningApi } from '../../../api/src/app';
import { startHttp } from '../../src/http';

let res: TestResources;
let api: RunningApi;
let mcpServer: Server;
let mcpUrl = '';
let demo: SeedResult;
let fullToken = '';
let readToken = '';
let client: Client;

interface ToolResult {
  isError?: boolean;
  structuredContent?: { result: Record<string, unknown>; untrusted: string[]; dryRun?: boolean; risk: string };
  content: Array<{ type: string; text: string }>;
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'contract-test', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

async function tool(name: string, args: Record<string, unknown>, c: Client = client): Promise<ToolResult> {
  return (await c.callTool({ name, arguments: args })) as unknown as ToolResult;
}

beforeAll(async () => {
  res = await createTestResources('mcp');
  const env = testEnv(res);
  api = await createApi({
    port: 0,
    host: '127.0.0.1',
    config: loadConfig({ ...process.env, ...env, REALTIME_URL: '' }),
  });
  demo = await seedDemo(api.core, { slug: `mcp-${res.id}`, workflows: false });
  const ctx = {
    tenantId: demo.tenantId,
    actor: { type: 'user' as const, id: demo.users['owner'] as string },
    causation: [],
  };
  await runInContext(ctx, async () => {
    fullToken = (
      await api.core.accounts.createApiToken(demo.users['owner'] as string, 'owner', {
        name: 'agent',
        actorType: 'agent',
        scopes: ['records:read', 'records:write', 'reports:read', 'email:send', 'invoices:send', 'invoices:void'],
      })
    ).token;
    readToken = (
      await api.core.accounts.createApiToken(demo.users['owner'] as string, 'owner', {
        name: 'reader',
        actorType: 'agent',
        scopes: ['records:read', 'reports:read'],
      })
    ).token;
  });
  mcpServer = await startHttp({ port: 0, host: '127.0.0.1', apiUrl: api.url });
  const addr = mcpServer.address();
  mcpUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/mcp`;
  client = await connect(fullToken);
});

afterAll(async () => {
  await client?.close();
  mcpServer?.close();
  await api?.close();
  await res?.drop();
});

describe('ops-mcp contract (Streamable HTTP)', () => {
  it('lists the tools with risk annotations (snapshot)', async () => {
    const { tools } = await client.listTools();
    const summary = tools.map((t) => ({
      name: t.name,
      annotations: t.annotations,
      risk: (t._meta as Record<string, unknown> | undefined)?.['x-risk'],
      inputs: Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort(),
      required: (t.inputSchema as { required?: string[] }).required ?? [],
    }));
    expect(summary).toMatchSnapshot();
    expect(tools).toHaveLength(16);
    expect(
      Object.fromEntries(tools.map((t) => [t.name, (t._meta as Record<string, unknown>)['x-risk']])),
    ).toMatchObject({
      void_invoice: 'irreversible',
      send_invoice: 'external',
      create_task: 'write_reversible',
      search_records: 'read',
    });
    const raw = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${fullToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const rawTools = (
      (await raw.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } }
    ).result.tools;
    expect(rawTools.find((t) => t.name === 'void_invoice')?.annotations['x-risk']).toBe('irreversible');
  });

  it('read tools return data and mark fields written by outside people as untrusted', async () => {
    const contacts = await tool('list_contacts', { limit: 50 });
    const items = contacts.structuredContent?.result['items'] as Array<{ id: string; source: string }>;
    const webForm = items.find((c) => c.source === 'web_form');
    expect(webForm).toBeDefined();
    const idx = items.indexOf(webForm!);
    expect(contacts.structuredContent?.untrusted).toContain(`items[${idx}].firstName`);
    const first = await runInContext(
      { tenantId: demo.tenantId, actor: { type: 'system', id: null }, causation: [] },
      () =>
        api.core.deps.db.scoped.activity.findFirst({
          where: { kind: 'email', data: { path: ['external'], equals: true } },
        }),
    );
    const detail = await tool('get_contact', { id: first!.subjectId });
    expect(detail.structuredContent?.untrusted.some((p) => /^activities\[\d+\]\.data\.body$/.test(p))).toBe(true);
    expect(detail.structuredContent?.risk).toBe('read');
  });

  it('list_invoices filters overdue invoices above an amount', async () => {
    const r = await tool('list_invoices', { overdueDays: 0, amountMinCents: 100_000 });
    const items = r.structuredContent?.result['items'] as Array<{
      status: string;
      totalCents: number;
      dueDate: string;
    }>;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(['sent', 'partially_paid', 'overdue']).toContain(i.status);
      expect(i.totalCents).toBeGreaterThanOrEqual(100_000);
      expect(new Date(i.dueDate).getTime()).toBeLessThan(Date.now());
    }
    const report = await tool('get_report', { name: 'ar_aging' });
    expect((report.structuredContent?.result['buckets'] as unknown[]).length).toBe(4);
  });

  it('dryRun previews without applying (update_deal, create_task, void_invoice)', async () => {
    const deals = (await tool('list_deals', { open: true, limit: 1 })).structuredContent?.result['items'] as Array<{
      id: string;
      amountCents: number;
    }>;
    const deal = deals[0]!;
    const preview = await tool('update_deal', {
      id: deal.id,
      patch: { amountCents: deal.amountCents + 1, stage: 'Negotiation' },
      dryRun: true,
    });
    expect(preview.structuredContent?.dryRun).toBe(true);
    expect((preview.structuredContent?.result['changes'] as Record<string, unknown>)['amountCents']).toEqual({
      from: deal.amountCents,
      to: deal.amountCents + 1,
    });
    const after = await tool('get_deal', { id: deal.id });
    expect((after.structuredContent?.result['deal'] as { amountCents: number }).amountCents).toBe(deal.amountCents);
    const taskPreview = await tool('create_task', { title: `dry-${res.id}`, dryRun: true });
    expect(taskPreview.isError).toBeFalsy();
    const found = await runInContext(
      { tenantId: demo.tenantId, actor: { type: 'system', id: null }, causation: [] },
      () => api.core.deps.db.scoped.task.count({ where: { title: `dry-${res.id}` } }),
    );
    expect(found).toBe(0);
    const invoices = (await tool('list_invoices', { overdueDays: 0, limit: 1 })).structuredContent?.result[
      'items'
    ] as Array<{ id: string; status: string }>;
    const voidPreview = await tool('void_invoice', { id: invoices[0]!.id, dryRun: true });
    expect((voidPreview.structuredContent?.result['change'] as { status: { to: string } }).status.to).toBe('void');
    expect(
      ((await tool('get_invoice', { id: invoices[0]!.id })).structuredContent?.result['invoice'] as { status: string })
        .status,
    ).toBe(invoices[0]!.status);
  });

  it('idempotencyKey makes retries of write tools apply once', async () => {
    const key = `idem-${res.id}-task`;
    const a = await tool('create_task', { title: `idem task ${res.id}`, idempotencyKey: key });
    const b = await tool('create_task', { title: `idem task ${res.id}`, idempotencyKey: key });
    expect((a.structuredContent?.result as { id: string }).id).toBe((b.structuredContent?.result as { id: string }).id);
    const draftKey = `idem-${res.id}-draft`;
    const d1 = await tool('draft_email', {
      to: [`idem-${res.id}@mcp.test`],
      subject: 'Hi',
      body: 'Body',
      idempotencyKey: draftKey,
    });
    const d2 = await tool('draft_email', {
      to: [`idem-${res.id}@mcp.test`],
      subject: 'Hi',
      body: 'Body',
      idempotencyKey: draftKey,
    });
    const draftId = (d1.structuredContent?.result as { id: string }).id;
    expect((d2.structuredContent?.result as { id: string }).id).toBe(draftId);
    const s1 = await tool('send_email', { draftId, idempotencyKey: `${draftKey}-send` });
    const s2 = await tool('send_email', { draftId, idempotencyKey: `${draftKey}-send` });
    expect((s1.structuredContent?.result as { status: string }).status).toBe('queued');
    expect((s2.structuredContent?.result as { status: string }).status).toBe('queued');
    const count = await runInContext(
      { tenantId: demo.tenantId, actor: { type: 'system', id: null }, causation: [] },
      () => api.core.deps.db.scoped.task.count({ where: { title: `idem task ${res.id}` } }),
    );
    expect(count).toBe(1);
    const effects = await api.core.deps.db.system.effectLog.findMany({
      where: { tenantId: demo.tenantId, idempotencyKey: { in: [key, draftKey, `${draftKey}-send`] } },
      orderBy: { effect: 'asc' },
    });
    expect(effects.map((e) => [e.origin, e.idempotencyKey, e.effect])).toEqual([
      ['api', draftKey, 'email.draft'],
      ['api', `${draftKey}-send`, `email.send:${draftId}`],
      ['api', key, 'task.create'],
    ]);
  });

  it('marks company names, nested web-form contacts, search hits and their change history as untrusted', async () => {
    const sys = { tenantId: demo.tenantId, actor: { type: 'system' as const, id: null }, causation: [] };
    const webCompany = await runInContext(sys, () =>
      api.core.deps.db.scoped.company.findFirst({ where: { source: 'web_form' } }),
    );
    const company = await tool('get_company', { id: webCompany!.id });
    expect(company.structuredContent?.untrusted).toEqual(expect.arrayContaining(['company.name', 'company.industry']));
    const webContact = await runInContext(sys, () =>
      api.core.deps.db.scoped.contact.findFirst({ where: { source: 'web_form', companyId: webCompany!.id } }),
    );
    await runInContext({ ...sys, actor: { type: 'user', id: demo.users['owner'] as string } }, async () => {
      await api.core.contacts.update(webContact!.id, { title: 'Head of IT' });
      await api.core.deals.create({ title: `nested-${res.id}`, contactId: webContact!.id, companyId: webCompany!.id });
      await api.core.tasks.create({ title: `related-${res.id}`, relatedType: 'contact', relatedId: webContact!.id });
      await api.core.deps.db.scoped.activity.create({
        data: {
          tenantId: demo.tenantId,
          subjectType: 'contact',
          subjectId: webContact!.id,
          kind: 'contact.updated',
          actorType: 'user',
          data: { changes: { title: { from: null, to: 'Head of IT' } } },
        },
      });
      await api.core.search.index('contact', webContact!.id);
      await api.core.search.index('company', webCompany!.id);
    });
    const deals = await tool('list_deals', { limit: 100 });
    const dealItems = deals.structuredContent?.result['items'] as Array<{ title: string }>;
    const di = dealItems.findIndex((d) => d.title === `nested-${res.id}`);
    expect(di).toBeGreaterThanOrEqual(0);
    expect(deals.structuredContent?.untrusted).toEqual(
      expect.arrayContaining([`items[${di}].contact.name`, `items[${di}].company.name`]),
    );
    const contacts = await tool('list_contacts', { limit: 100 });
    const ci = (contacts.structuredContent?.result['items'] as Array<{ id: string }>).findIndex(
      (c) => c.id === webContact!.id,
    );
    expect(contacts.structuredContent?.untrusted).toEqual(
      expect.arrayContaining([`items[${ci}].name`, `items[${ci}].title`, `items[${ci}].company.name`]),
    );
    const search = await tool('search_records', { query: webContact!.lastName, types: ['contact'] });
    const hits = (search.structuredContent?.result['groups'] as Array<{ hits: Array<{ id: string }> }>)[0]!.hits;
    const hi = hits.findIndex((h) => h.id === webContact!.id);
    expect(search.structuredContent?.untrusted).toEqual(
      expect.arrayContaining([`groups[0].hits[${hi}].title`, `groups[0].hits[${hi}].subtitle`]),
    );
    const detail = await tool('get_contact', { id: webContact!.id });
    const acts = detail.structuredContent?.result['activities'] as Array<{ kind: string }>;
    const ui = acts.findIndex((a) => a.kind === 'contact.updated');
    expect(ui).toBeGreaterThanOrEqual(0);
    expect(detail.structuredContent?.untrusted).toContain(`activities[${ui}].data.changes`);
    const plain = await runInContext(sys, () =>
      api.core.deps.db.scoped.contact.findFirst({ where: { source: 'manual' }, orderBy: { id: 'asc' } }),
    );
    const plainDetail = await tool('get_contact', { id: plain!.id });
    expect(plainDetail.structuredContent?.untrusted.filter((p) => p.startsWith('contact.'))).toEqual([]);
    expect(detail.structuredContent?.untrusted).toEqual(
      expect.arrayContaining(['contact.firstName', 'contact.lastName', 'contact.name', 'contact.title']),
    );
  });

  it('list tools page through every record with cursors, without gaps or duplicates', async () => {
    for (const [name, total] of [
      ['list_contacts', 48],
      ['list_deals', 0],
      ['list_invoices', 0],
    ] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await tool(name, { limit: 7, ...(cursor === undefined ? {} : { cursor }) });
        expect(r.isError).toBeFalsy();
        const page = r.structuredContent?.result as { items: Array<{ id: string }>; nextCursor: string | null };
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 50);
      expect(new Set(seen).size).toBe(seen.length);
      const all = await tool(name, { limit: 100 });
      const ids = (all.structuredContent?.result as { items: Array<{ id: string }> }).items.map((i) => i.id);
      expect(seen).toEqual(ids);
      if (total > 0) expect(seen.length).toBeGreaterThanOrEqual(total);
      expect(pages).toBeGreaterThan(1);
    }
  });

  it('search hits with equal scores come back in a stable order (score, title, id)', async () => {
    await runInContext(
      { tenantId: demo.tenantId, actor: { type: 'user', id: demo.users['owner'] as string }, causation: [] },
      async () => {
        for (let i = 0; i < 6; i += 1) {
          const c = await api.core.companies.create({ name: `Twin Peaks ${res.id}` });
          await api.core.search.index('company', c.id);
        }
      },
    );
    const run = async () =>
      (
        (await tool('search_records', { query: `Twin Peaks ${res.id}`, types: ['company'] })).structuredContent?.result[
          'groups'
        ] as Array<{ hits: Array<{ id: string; score: number; title: string }> }>
      )[0]!.hits;
    const a = await run();
    const b = await run();
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    const sorted = [...a].sort(
      (x, y) => y.score - x.score || (x.title < y.title ? -1 : x.title > y.title ? 1 : 0) || (x.id < y.id ? -1 : 1),
    );
    expect(a.map((h) => h.id)).toEqual(sorted.map((h) => h.id));
    expect(new Set(a.map((h) => h.score)).size).toBe(1);
  });

  it('acts with the token’s permissions: a read-only token cannot write', async () => {
    const reader = await connect(readToken);
    const r = await tool('create_task', { title: 'forbidden' }, reader);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/403 insufficient_scope/);
    await reader.close();
  });

  it('rejects requests without a token', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
  });

  it('works over stdio too (Claude Desktop / IDE transport)', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/main.js')],
      env: { ...(process.env as Record<string, string>), BOP_API_URL: api.url, BOP_API_TOKEN: readToken },
    });
    const c = new Client({ name: 'stdio-test', version: '1.0.0' });
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(16);
    const r = (await c.callTool({
      name: 'search_records',
      arguments: { query: 'Northwind' },
    })) as unknown as ToolResult;
    expect(JSON.stringify(r.structuredContent?.result)).toContain('Northwind Traders');
    await c.close();
  });
});
