import { expect, type Locator, type Page } from '@playwright/test';
import { API, MAILPIT } from './stack';

export async function login(page: Page, email: string, password = 'demo1234'): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('nav-companies')).toBeVisible();
}

export async function apiToken(email: string): Promise<string> {
  const r = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

export async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return (text === '' ? null : JSON.parse(text)) as T;
}

export async function mailCount(query: string): Promise<number> {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=50`);
  return (((await r.json()) as { messages?: unknown[] }).messages ?? []).length;
}

export async function pickRecord(page: Page, testId: string, search: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.locator('[cmdk-input]').fill(search);
  await page.getByRole('option').filter({ hasText: search }).first().click();
}

export async function dragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('drag source or target not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(120, to.height / 2), { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

export const uid = () => Math.random().toString(36).slice(2, 8);
