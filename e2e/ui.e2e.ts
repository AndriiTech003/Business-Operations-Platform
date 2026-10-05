import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { api, apiToken, login, uid } from './helpers';

interface Pipeline {
  isDefault: boolean;
  stages: Array<{ id: string; name: string; kind: string; position: number }>;
}
interface Deal {
  id: string;
  stageId: string;
  lostReason: string | null;
}

let owner = '';

test.beforeAll(async () => {
  owner = await apiToken('demo@demo.dev');
});

async function stages(): Promise<Pipeline['stages']> {
  const pipelines = await api<Pipeline[]>(owner, 'GET', '/v1/pipelines');
  const p = pipelines.find((x) => x.isDefault) ?? pipelines[0];
  return [...(p?.stages ?? [])].sort((a, b) => a.position - b.position);
}

async function publishedWorkflow(definition: Record<string, unknown>): Promise<string> {
  const wf = await api<{ id: string }>(owner, 'POST', '/v1/workflows', {
    name: String(definition['name']),
    definition,
  });
  await api(owner, 'POST', `/v1/workflows/${wf.id}/publish`, {});
  return wf.id;
}

async function runStatus(page: Page): Promise<string | null> {
  return page.getByTestId('run-detail').getAttribute('data-run-status');
}

test('dark mode toggle switches the theme and survives a reload', async ({ page }) => {
  await login(page, 'demo@demo.dev');
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/dark/);
  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.localStorage.getItem('bop.theme'))).toBe('dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
  await page.getByTestId('theme-toggle').click();
  await expect(html).not.toHaveClass(/dark/);
  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
});

test('kanban keyboard moves reach every column, including columns scrolled out of view', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  const all = await stages();
  const first = all[0]!;
  const won = all.find((s) => s.kind === 'won')!;
  const lost = all.find((s) => s.kind === 'lost')!;
  const tag = uid();
  const a = await api<Deal>(owner, 'POST', '/v1/deals', { title: `Keyboard A ${tag}`, stageId: first.id });
  const b = await api<Deal>(owner, 'POST', '/v1/deals', { title: `Keyboard B ${tag}`, stageId: first.id });
  await login(page, 'demo@demo.dev');
  await page.goto('/deals');
  const board = page.getByTestId('kanban');
  await expect(board).toBeVisible();
  const lostColumn = page.getByTestId(`kanban-column-${lost.name}`);
  const visible = await lostColumn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left < window.innerWidth && r.right > 0;
  });
  expect(visible).toBe(false);

  const moveBy = async (dealId: string, steps: number) => {
    const handle = page.locator(`[aria-roledescription="Draggable deal"]:has([data-testid="deal-card-${dealId}"])`);
    await expect(handle).toBeVisible();
    await expect(async () => {
      await handle.focus();
      await page.keyboard.press('Space');
      await expect(handle).toHaveAttribute('aria-pressed', 'true', { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    for (let i = 0; i < steps; i += 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(100);
    }
    await page.keyboard.press('Space');
  };

  await moveBy(a.id, all.indexOf(won));
  await expect(page.getByTestId(`kanban-column-${won.name}`).getByTestId(`deal-card-${a.id}`)).toBeVisible();
  await expect.poll(async () => (await api<Deal>(owner, 'GET', `/v1/deals/${a.id}`)).stageId).toBe(won.id);

  await moveBy(b.id, all.indexOf(lost));
  await expect(page.getByTestId('lost-reason-dialog')).toBeVisible();
  await page.getByTestId('lost-reason').fill('Moved with the keyboard');
  await page.getByTestId('dialog-submit').click();
  await expect(lostColumn.getByTestId(`deal-card-${b.id}`)).toBeVisible();
  await expect
    .poll(async () => {
      const d = await api<Deal>(owner, 'GET', `/v1/deals/${b.id}`);
      return [d.stageId, d.lostReason];
    })
    .toEqual([lost.id, 'Moved with the keyboard']);
});

test('run replay: retry a failed step, then cancel a waiting run', async ({ page }) => {
  const tag = uid();
  const port = 4567;
  const failing = await publishedWorkflow({
    name: `Retry me ${tag}`,
    trigger: { type: 'manual' },
    nodes: [
      {
        id: 'call',
        type: 'http_request',
        config: { method: 'POST', url: `http://127.0.0.1:${port}/e2e-${tag}`, body: '{"ok":true}' },
        retry: { maxAttempts: 1 },
      },
    ],
    edges: [{ from: '$trigger', to: 'call' }],
  });
  const run = await api<{ id: string }>(owner, 'POST', `/v1/workflows/${failing}/runs`, {});
  await login(page, 'demo@demo.dev');
  await page.goto(`/runs/${run.id}`);
  await expect.poll(() => runStatus(page), { timeout: 60_000 }).toBe('failed');

  let server: Server | null = null;
  let hits = 0;
  try {
    server = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"received":true}');
    });
    await new Promise<void>((r) => server?.listen(port, '127.0.0.1', r));
    await page.getByTestId('retry-failed-step').click();
    await expect.poll(() => runStatus(page), { timeout: 60_000 }).toBe('succeeded');
    expect(hits).toBe(1);
    const detail = await api<{ steps: Array<{ nodeId: string; status: string; attempt: number }> }>(
      owner,
      'GET',
      `/v1/workflow-runs/${run.id}`,
    );
    expect(detail.steps.find((s) => s.nodeId === 'call')).toMatchObject({ status: 'succeeded' });
  } finally {
    server?.closeAllConnections();
    server?.close();
  }

  const waiting = await publishedWorkflow({
    name: `Cancel me ${tag}`,
    trigger: { type: 'manual' },
    nodes: [
      { id: 'pause', type: 'wait_duration', config: { duration: 'days(1)' } },
      { id: 'after', type: 'create_task', config: { title: `Never ${tag}` } },
    ],
    edges: [
      { from: '$trigger', to: 'pause' },
      { from: 'pause', to: 'after' },
    ],
  });
  const run2 = await api<{ id: string }>(owner, 'POST', `/v1/workflows/${waiting}/runs`, {});
  await page.goto(`/runs/${run2.id}`);
  await expect.poll(() => runStatus(page), { timeout: 60_000 }).toBe('waiting');
  await page.getByTestId('cancel-run').click();
  await page.getByTestId('confirm-cancel-run').click();
  await expect.poll(() => runStatus(page), { timeout: 30_000 }).toBe('cancelled');
  await expect(page.getByTestId('cancel-run')).toHaveCount(0);
  const tasks = await api<{ items: unknown[] }>(owner, 'GET', `/v1/tasks?q=${encodeURIComponent(`Never ${tag}`)}`);
  expect(tasks.items).toHaveLength(0);
});

const FAKE_COMPONENT = `
class FakeAskOperator extends HTMLElement {
  connectedCallback() {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Ask operator';
    b.dataset.testid = 'ask-operator-button';
    b.dataset.record = this.getAttribute('record-type') + ':' + this.getAttribute('record-id');
    b.dataset.agent = this.getAttribute('agent-url') || '';
    this.appendChild(b);
  }
}
if (!customElements.get('ask-operator')) customElements.define('ask-operator', FakeAskOperator);
`;

test('"Ask operator" panel loads the configured web component on record pages and is hidden otherwise', async ({
  page,
}) => {
  const tag = uid();
  const deal = await api<Deal>(owner, 'POST', '/v1/deals', { title: `Operator ${tag}` });
  let scriptLoads = 0;
  await page.route('http://127.0.0.1:4565/embed/ask-operator.js', async (route) => {
    scriptLoads += 1;
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_COMPONENT });
  });
  await login(page, 'demo@demo.dev');
  await page.goto(`/deals/${deal.id}`);
  const button = page.getByTestId('ask-operator-button');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('data-record', `deal:${deal.id}`);
  await expect(button).toHaveAttribute('data-agent', 'http://127.0.0.1:4566');
  expect(scriptLoads).toBe(1);

  const other = await page.context().newPage();
  await other.route('**/v1/app-config', (route) => route.fulfill({ json: { operator: null } }));
  await other.goto(`/deals/${deal.id}`);
  await expect(other.getByTestId('record-title')).toHaveText(`Operator ${tag}`);
  await expect(other.getByTestId('operator-slot')).toHaveCount(0);
  await expect(other.getByTestId('ask-operator-button')).toHaveCount(0);
  await other.close();
});
