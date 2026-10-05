import { expect, test } from '@playwright/test';
import { api, apiToken, dragTo, login, mailCount, pickRecord, uid } from './helpers';

interface Workflow {
  id: string;
  templateKey: string | null;
}
interface Invoice {
  id: string;
  number: string;
}
interface Template {
  key: string;
  definition: {
    trigger: { condition?: string };
    nodes: Array<{ id: string; config: Record<string, unknown> }>;
    [k: string]: unknown;
  };
}

let owner = '';

test.beforeAll(async () => {
  owner = await apiToken('demo@demo.dev');
  const workflows = await api<Workflow[]>(owner, 'GET', '/v1/workflows');
  const seeded = workflows.find((w) => w.templateKey === 'overdue_invoice');
  if (seeded) await api(owner, 'PATCH', `/v1/workflows/${seeded.id}`, { status: 'paused' });
});

async function overdueInvoice(tag: string): Promise<{ invoice: Invoice; email: string }> {
  const email = `e2e-${tag}@buyer.test`;
  const company = await api<{ id: string }>(owner, 'POST', '/v1/companies', { name: `Overdue Buyer ${tag}` });
  const contact = await api<{ id: string }>(owner, 'POST', '/v1/contacts', {
    firstName: 'Olga',
    lastName: tag,
    email,
    companyId: company.id,
  });
  const invoice = await api<Invoice>(
    owner,
    'POST',
    '/v1/invoices',
    {
      companyId: company.id,
      contactId: contact.id,
      issueDate: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      dueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      lines: [{ description: 'Annual plan', quantity: 1, unitPriceCents: 250_000, taxRate: 0 }],
    },
    { 'idempotency-key': `e2e-${tag}` },
  );
  await api(owner, 'POST', `/v1/invoices/${invoice.id}/send`, {}, { 'idempotency-key': `e2e-send-${tag}` });
  return { invoice, email };
}

test('1. create company, contact and deal, drag it to Won → onboarding workflow creates tasks and a draft invoice (timeline)', async ({
  page,
}) => {
  const tag = uid();
  await login(page, 'demo@demo.dev');

  await page.getByTestId('nav-companies').click();
  await page.getByTestId('create-company').click();
  await page.getByTestId('field-name').fill(`E2E Co ${tag}`);
  await page.getByTestId('dialog-submit').click();
  await expect(page.getByTestId('record-title')).toContainText(`E2E Co ${tag}`);

  await page.getByTestId('nav-contacts').click();
  await page.getByTestId('create-contact').click();
  await page.getByTestId('field-firstName').fill('Erin');
  await page.getByTestId('field-lastName').fill(`E2E ${tag}`);
  await page.getByTestId('field-email').fill(`erin-${tag}@e2e.test`);
  await pickRecord(page, 'field-companyId', `E2E Co ${tag}`);
  await page.getByTestId('dialog-submit').click();
  await expect(page.getByTestId('record-title')).toContainText(`Erin E2E ${tag}`);

  await page.getByTestId('nav-deals').click();
  await page.getByTestId('create-deal').click();
  await page.getByTestId('field-title').fill(`E2E deal ${tag}`);
  await page.getByTestId('field-amountCents').fill('12000');
  await page.getByTestId('field-stageId').selectOption({ label: 'Negotiation' });
  await pickRecord(page, 'field-companyId', `E2E Co ${tag}`);
  await page.getByTestId('dialog-submit').click();

  const card = page.locator(`[data-testid^="deal-card-"][data-deal-title="E2E deal ${tag}"]`).first();
  await expect(card).toBeVisible();
  const dealId = ((await card.getAttribute('data-testid')) ?? '').replace('deal-card-', '');
  expect(dealId).toMatch(/^[0-9a-f-]{36}$/);
  const won = page.getByTestId('kanban-column-Won');
  await won.scrollIntoViewIfNeeded();
  await dragTo(page, card, won);
  await expect(won.getByTestId(`deal-card-${dealId}`)).toBeVisible();

  await page.goto(`/deals/${dealId}`);
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-testid="timeline-item"][data-kind="deal.won"]')).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.getByTestId('tab-activity').click();
        return page.locator('[data-testid="timeline-item"][data-actor="workflow"]').count();
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.getByTestId('tab-tasks').click();
  await expect(page.getByTestId('task-row').filter({ hasText: 'Kickoff call' })).toBeVisible();
  await expect(page.getByTestId('task-row').filter({ hasText: 'Send welcome pack' })).toBeVisible();
  await page.getByTestId('tab-related').click();
  await expect(page.getByTestId('related-invoice')).toContainText(/Draft/i);
});

test('2. builder: overdue template, edit condition with autocomplete, publish → overdue invoice → email in Mailpit → task created', async ({
  page,
}) => {
  const tag = uid();
  const { invoice, email } = await overdueInvoice(tag);
  await login(page, 'demo@demo.dev');
  await page.getByTestId('nav-workflows').click();
  await page.getByTestId('create-workflow').click();
  await page.getByTestId('template-overdue_invoice').click();
  await page.getByTestId('field-name').fill(`E2E overdue ${tag}`);
  await page.getByTestId('dialog-submit').click();
  await expect(page.getByTestId('wf-canvas')).toBeVisible();

  await page.getByTestId('wf-node-$trigger').click();
  const condition = page.getByTestId('expr-condition').locator('.cm-content');
  await condition.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and invoice.numb');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('number');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.keyboard.type(` == '${invoice.number}'`);
  await expect(page.getByTestId('expr-condition')).toContainText(`invoice.number == '${invoice.number}'`);

  await page.getByTestId('wf-node-big').click();
  const big = page.getByTestId('expr-expr').locator('.cm-content');
  await big.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('invoice.totl');
  await expect(page.getByTestId('field-issues')).toContainText(/totl/);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('invoice.bala');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('balanceCents');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.keyboard.type(' > 100000');
  await expect(page.getByTestId('field-issues')).toHaveCount(0);

  await expect(page.getByTestId('wf-save-state')).toContainText(/saved/i, { timeout: 15_000 });
  await page.getByTestId('wf-publish').click();
  await expect(page.getByTestId('publish-diff')).toBeVisible();
  await page.getByTestId('wf-publish-confirm').click();
  await expect(page.getByTestId('wf-status')).toContainText(/active|v1/i);

  await expect.poll(() => mailCount(`to:${email} subject:Reminder`), { timeout: 90_000 }).toBe(1);
  await expect
    .poll(
      async () =>
        (await api<Array<{ title: string }>>(owner, 'GET', `/v1/records/invoice/${invoice.id}/tasks`)).some((t) =>
          t.title.includes(invoice.number),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('3. approval: run waits for a manager, approve in the inbox → final notice email', async ({ page }) => {
  const tag = uid();
  const { invoice, email } = await overdueInvoice(tag);
  const template = (await api<Template[]>(owner, 'GET', '/v1/workflows/templates')).find(
    (t) => t.key === 'overdue_invoice',
  ) as Template;
  const definition = structuredClone(template.definition);
  definition['name'] = `E2E approval ${tag}`;
  definition.trigger.condition = `invoice.status in ['sent', 'overdue'] and invoice.dueDate < now() - days(1) and invoice.number == '${invoice.number}'`;
  const wait = definition.nodes.find((n) => n.id === 'wait_paid');
  if (wait) wait.config['timeout'] = 'hours(1) / 3600';
  const wf = await api<{ id: string }>(owner, 'POST', '/v1/workflows', { name: `E2E approval ${tag}`, definition });
  await api(owner, 'POST', `/v1/workflows/${wf.id}/publish`);

  await login(page, 'manager@demo.dev');
  await page.getByTestId('nav-approvals').click();
  const card = page.getByTestId('approval-card').filter({ hasText: invoice.number });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('approvals-badge')).toBeVisible();
  await card.getByTestId('approval-comment').fill('Go ahead');
  await card.getByTestId('approval-approve').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => mailCount(`to:${email} subject:"Final notice"`), { timeout: 60_000 }).toBe(1);
});

test('4. two browsers: a deal moved in one window appears in the other (realtime)', async ({ browser }) => {
  const tag = uid();
  const pipeline = (
    await api<Array<{ stages: Array<{ id: string; name: string }> }>>(owner, 'GET', '/v1/pipelines')
  )[0]!;
  const lead = pipeline.stages.find((s) => s.name === 'Lead')!;
  const deal = await api<{ id: string }>(owner, 'POST', '/v1/deals', {
    title: `Realtime deal ${tag}`,
    amountCents: 5000,
    stageId: lead.id,
  });

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await login(pa, 'demo@demo.dev');
  await login(pb, 'anna@demo.dev');
  await pa.goto('/deals');
  await pb.goto('/deals');
  await expect(pb.getByTestId('realtime-status')).toContainText(/live/i, { timeout: 30_000 });
  const cardA = pa.getByTestId(`deal-card-${deal.id}`);
  await expect(cardA).toBeVisible();
  await expect(pb.getByTestId('kanban-column-Lead').getByTestId(`deal-card-${deal.id}`)).toBeVisible();
  await dragTo(pa, cardA, pa.getByTestId('kanban-column-Qualified'));
  await expect(pa.getByTestId('kanban-column-Qualified').getByTestId(`deal-card-${deal.id}`)).toBeVisible();
  await expect(pb.getByTestId('kanban-column-Qualified').getByTestId(`deal-card-${deal.id}`)).toBeVisible({
    timeout: 15_000,
  });
  await a.close();
  await b.close();
});
