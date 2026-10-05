import { randomUUID } from 'node:crypto';
import { RealtimeClient } from '../apps/web/node_modules/@ashamrai/realtime-client/dist/index.js';
import { Client } from '../apps/ops-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/ops-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const API = process.env.API_URL;
const WEB = process.env.WEB_URL;
const MCP = process.env.MCP_URL;
const MAILPIT = process.env.MAILPIT_URL;
const ID = process.env.SMOKE_ID;
let checks = 0;

function ok(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  checks += 1;
  console.log(`  ✔ ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 60_000, interval = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function http(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (res.status >= 400)
    throw new Error(`${method} ${path} → ${res.status} ${typeof json === 'object' ? JSON.stringify(json) : json}`);
  return { status: res.status, headers: res.headers, json };
}

async function login(email) {
  return (await http('POST', '/v1/auth/login', { body: { email, password: 'demo1234' } })).json.accessToken;
}

async function mail(query) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=50`);
  return (await res.json()).messages ?? [];
}

console.log('smoke: services');
ok((await http('GET', '/health')).json.status === 'ok', 'api health: postgres + redis ok');
const html = await (await fetch(`${WEB}/`)).text();
ok(html.includes('<div id="root">') || html.includes('id="root"'), 'web SPA (production build) is served');
ok((await fetch(`${WEB}/p/invoices/anything`)).status === 200, 'web serves client-side routes');
ok((await (await fetch(`${API}/openapi.json`)).json()).openapi === '3.1.0', 'OpenAPI document');

console.log('smoke: CRM');
const owner = await login('demo@demo.dev');
const manager = await login('manager@demo.dev');
const me = (await http('GET', '/v1/me', { token: owner })).json;
ok(me.role === 'owner' && me.tenant.slug === 'acme', 'login as owner of the demo tenant');
const members = (await http('GET', '/v1/members', { token: owner })).json;
const anna = members.find((m) => m.email === 'anna@demo.dev');
const company = (
  await http('POST', '/v1/companies', {
    token: owner,
    body: { name: `Smoke Industries ${ID}`, domain: `smoke-${ID}.test`, ownerId: anna.id, custom: { region: 'EMEA' } },
  })
).json;
const email = `buyer-${ID}@smoke.test`;
const contact = (
  await http('POST', '/v1/contacts', {
    token: owner,
    body: { firstName: 'Sam', lastName: 'Smoke', email, companyId: company.id },
  })
).json;
ok(contact.company?.id === company.id, 'company and contact created');
const patched = (await http('PATCH', `/v1/contacts/${contact.id}`, { token: owner, body: { title: 'Head of Ops' } }))
  .json;
ok(
  patched.lastName === 'Smoke' && patched.firstName === 'Sam' && patched.title === 'Head of Ops',
  'PATCH keeps omitted fields',
);
await http('POST', '/v1/comments', {
  token: owner,
  body: { subjectType: 'company', subjectId: company.id, body: `@[Anna Sales](${anna.id}) new account` },
});
const annaToken = await login('anna@demo.dev');
await waitFor(
  async () =>
    (await http('GET', '/v1/notifications?unread=1', { token: annaToken })).json.items.some(
      (n) => n.kind === 'mention',
    ),
  'mention notification',
);
ok(true, '@mention notified Anna');
await waitFor(
  async () =>
    (await http('GET', `/v1/search?q=${encodeURIComponent(`Smoke Industries ${ID}`)}`, { token: owner })).json.groups
      .length > 0,
  'search index',
);
ok(true, 'global search finds the new company (FTS from outbox events)');

console.log('smoke: realtime (project 03 engine)');
const ticketInfo = (await http('POST', '/v1/realtime/ticket', { token: owner })).json;
const rt = new RealtimeClient({
  url: ticketInfo.url,
  getTicket: async () => (await http('POST', '/v1/realtime/ticket', { token: owner })).json.ticket,
});
const dealsChannel = rt.subscribe(`room:t.${me.tenant.id}.deals`);
const realtimeMessages = [];
dealsChannel.on('message', (m) => realtimeMessages.push(m.d));
await sleep(1000);

console.log('smoke: deal won → onboarding workflow');
const pipeline = (await http('GET', '/v1/pipelines', { token: owner })).json[0];
const won = pipeline.stages.find((s) => s.kind === 'won');
const deal = (
  await http('POST', '/v1/deals', {
    token: owner,
    body: {
      title: `Smoke deal ${ID}`,
      companyId: company.id,
      contactId: contact.id,
      amountCents: 4_200_000,
      ownerId: anna.id,
    },
  })
).json;
await http('PATCH', `/v1/deals/${deal.id}/move`, {
  token: owner,
  body: { stageId: won.id },
  headers: { 'if-match': `W/"${deal.version}"` },
});
const workflows = (await http('GET', '/v1/workflows', { token: owner })).json;
const dealWon = workflows.find((w) => w.templateKey === 'deal_won');
const run = await waitFor(async () => {
  const runs = (await http('GET', `/v1/workflow-runs?workflowId=${dealWon.id}`, { token: owner })).json.items;
  const detail = runs.length > 0 ? (await http('GET', `/v1/workflow-runs/${runs[0].id}`, { token: owner })).json : null;
  return detail && detail.triggerPayload.recordId === deal.id && detail.status === 'succeeded' ? detail : null;
}, 'deal won run');
ok(
  run.steps.filter((s) => s.nodeType === 'create_task' && s.status === 'succeeded').length === 2,
  'deal won workflow created 2 onboarding tasks',
);
const draftInvoices = (
  await http(
    'GET',
    `/v1/invoices?filter=${encodeURIComponent(JSON.stringify([{ field: 'dealId', op: 'eq', value: deal.id }]))}`,
    { token: owner },
  )
).json.items;
ok(
  draftInvoices.length === 1 &&
    draftInvoices[0].status === 'draft' &&
    draftInvoices[0].totalCents === 4_200_000 &&
    draftInvoices[0].createdByType === 'workflow',
  'deal won workflow created a draft invoice',
);
const timeline = await waitFor(async () => {
  const t = (await http('GET', `/v1/deals/${deal.id}/timeline`, { token: owner })).json.items;
  return t.some((a) => a.actorType === 'workflow' && a.kind === 'note') ? t : null;
}, 'timeline note');
ok(
  timeline.some((a) => a.kind === 'deal.won'),
  'deal timeline shows the stage change and the workflow note',
);
await waitFor(
  async () => realtimeMessages.some((m) => m.dealId === deal.id && m.type === 'deal.stage_changed'),
  'realtime deal move',
);
ok(true, 'kanban move delivered over the realtime server');
rt.close();

console.log('smoke: overdue invoice workflow with approval');
const seededOverdue = workflows.find((w) => w.templateKey === 'overdue_invoice');
await http('PATCH', `/v1/workflows/${seededOverdue.id}`, { token: owner, body: { status: 'paused' } });
const template = (await http('GET', '/v1/workflows/templates', { token: owner })).json.find(
  (t) => t.key === 'overdue_invoice',
);
const definition = structuredClone(template.definition);
definition.name = `Overdue follow-up (smoke ${ID})`;
definition.trigger.condition = `invoice.status in ['sent', 'overdue'] and invoice.dueDate < now() - days(1) and invoice.number == '${'__NUMBER__'}'`;
const wfCreated = (await http('POST', '/v1/workflows', { token: owner, body: { name: definition.name } })).json;
const invoiceBody = {
  companyId: company.id,
  contactId: contact.id,
  issueDate: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  dueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  lines: [{ description: 'Annual plan', quantity: 1, unitPriceCents: 250_000, taxRate: 20 }],
};
const invoice = (
  await http('POST', '/v1/invoices', {
    token: owner,
    headers: { 'idempotency-key': `smoke-${ID}-invoice` },
    body: invoiceBody,
  })
).json;
const replay = await http('POST', '/v1/invoices', {
  token: owner,
  headers: { 'idempotency-key': `smoke-${ID}-invoice` },
  body: invoiceBody,
});
ok(
  replay.json.id === invoice.id && replay.headers.get('idempotent-replayed') === 'true',
  'Idempotency-Key replays invoice creation',
);
definition.trigger.condition = definition.trigger.condition.replace('__NUMBER__', invoice.number);
const waitNode = definition.nodes.find((n) => n.id === 'wait_paid');
waitNode.config.timeout = 'hours(1) / 3600';
const saved = (await http('PUT', `/v1/workflows/${wfCreated.id}/draft`, { token: owner, body: { definition } })).json;
ok(
  saved.issues.filter((i) => i.severity === 'error').length === 0,
  'edited template validates (expression type checks)',
);
await http('POST', `/v1/workflows/${wfCreated.id}/publish`, { token: owner });
await http('POST', `/v1/invoices/${invoice.id}/send`, {
  token: owner,
  headers: { 'idempotency-key': `smoke-${ID}-send` },
  body: {},
});
const sentMail = await waitFor(
  async () => (await mail(`to:${email} subject:"Invoice ${invoice.number}"`))[0],
  'invoice email',
);
const sentDetail = await (await fetch(`${MAILPIT}/api/v1/message/${sentMail.ID}`)).json();
ok(
  sentDetail.Attachments.some((a) => a.FileName === `${invoice.number}.pdf` && a.ContentType === 'application/pdf'),
  'invoice email in Mailpit has the PDF rendered by the Chromium worker',
);
const pdf = await fetch(`${API}/v1/invoices/${invoice.id}/pdf`, { headers: { authorization: `Bearer ${owner}` } });
ok(
  pdf.headers.get('content-type') === 'application/pdf' && (await pdf.arrayBuffer()).byteLength > 1000,
  'GET /invoices/:id/pdf returns a PDF',
);
await waitFor(async () => (await mail(`to:${email} subject:Reminder`)).length > 0, 'reminder email', 90_000);
ok(true, 'record_condition scanner started the run and the reminder email reached Mailpit');
const approval = await waitFor(
  async () =>
    (await http('GET', '/v1/approvals?status=pending&mine=1', { token: manager })).json.find((a) =>
      a.title.includes(invoice.number),
    ),
  'approval in inbox',
  60_000,
);
ok(approval.source === 'workflow', 'approval waits in the manager inbox');
await http('POST', `/v1/approvals/${approval.id}/decide`, {
  token: manager,
  body: { decision: 'approve', comment: 'send it' },
});
await waitFor(
  async () => (await mail(`to:${email} subject:"Final notice"`)).length === 1,
  'final notice email',
  60_000,
);
ok(true, 'approved → final notice in Mailpit (exactly one)');
const runs = (await http('GET', `/v1/workflow-runs?workflowId=${wfCreated.id}`, { token: owner })).json.items;
const overdueRun = (await http('GET', `/v1/workflow-runs/${runs[0].id}`, { token: owner })).json;
ok(
  overdueRun.status === 'succeeded' && overdueRun.steps.find((s) => s.nodeId === 'escalate').outcome === 'approved',
  'overdue run succeeded through the approved edge',
);
const tasks = (await http('GET', `/v1/records/invoice/${invoice.id}/tasks`, { token: owner })).json;
ok(
  tasks.some((t) => t.title.includes(invoice.number) && t.createdByType === 'workflow'),
  'workflow created the follow-up task',
);
const pub = (await http('GET', `/p/invoices/${invoice.publicToken}`)).json;
ok(pub.number === invoice.number && pub.balanceCents === 300_000, 'public invoice page by token');

console.log('smoke: reports');
for (const p of [
  '/v1/reports/pipeline',
  '/v1/reports/revenue',
  '/v1/reports/ar-aging',
  '/v1/reports/activity',
  '/v1/deals/forecast',
])
  await http('GET', p, { token: owner });
ok(
  (await http('GET', '/v1/reports/ar-aging', { token: owner })).json.buckets.length === 4,
  'reports respond (AR aging buckets)',
);

console.log('smoke: ops-mcp over Streamable HTTP');
const pat = (
  await http('POST', '/v1/api-tokens', {
    token: owner,
    body: {
      name: `smoke agent ${ID}`,
      actorType: 'agent',
      scopes: ['records:read', 'records:write', 'reports:read', 'invoices:void'],
    },
  })
).json.token;
const mcp = new Client({ name: 'smoke', version: '1.0.0' });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${pat}` } } }),
);
const { tools } = await mcp.listTools();
ok(
  tools.length === 16 &&
    tools.find((t) => t.name === 'void_invoice')._meta['x-risk'] === 'irreversible' &&
    tools.find((t) => t.name === 'void_invoice').annotations.destructiveHint === true,
  'MCP lists 16 tools with risk metadata',
);
const overdue = await mcp.callTool({ name: 'list_invoices', arguments: { overdueDays: 0, amountMinCents: 100_000 } });
ok(overdue.structuredContent.result.items.length > 0, 'MCP list_invoices: overdue invoices above $1000');
const contacts = await mcp.callTool({ name: 'list_contacts', arguments: { limit: 50 } });
ok(contacts.structuredContent.untrusted.length > 0, 'MCP marks untrusted fields');
const page1 = await mcp.callTool({ name: 'list_contacts', arguments: { limit: 20 } });
const page2 = await mcp.callTool({
  name: 'list_contacts',
  arguments: { limit: 20, cursor: page1.structuredContent.result.nextCursor },
});
ok(
  page1.structuredContent.result.nextCursor !== null &&
    page2.structuredContent.result.items.length > 0 &&
    !page2.structuredContent.result.items.some((c) => page1.structuredContent.result.items.some((d) => d.id === c.id)),
  'MCP list tools page with cursors',
);
const appConfig = (await http('GET', '/v1/app-config')).json;
ok(appConfig !== null && 'operator' in appConfig, 'app-config is public');
const dry = await mcp.callTool({ name: 'void_invoice', arguments: { id: invoice.id, dryRun: true } });
ok(
  dry.structuredContent.result.dryRun === true &&
    (await http('GET', `/v1/invoices/${invoice.id}`, { token: owner })).json.status !== 'void',
  'MCP dryRun previews without applying',
);
const key = randomUUID();
const t1 = await mcp.callTool({ name: 'create_task', arguments: { title: `MCP task ${ID}`, idempotencyKey: key } });
const t2 = await mcp.callTool({ name: 'create_task', arguments: { title: `MCP task ${ID}`, idempotencyKey: key } });
ok(t1.structuredContent.result.id === t2.structuredContent.result.id, 'MCP idempotencyKey applies the write once');
await mcp.close();

console.log(`smoke: ${checks} checks passed`);
