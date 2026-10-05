import type { Logger } from 'pino';
import { chromium, type Browser } from 'playwright';

export class PdfRenderer {
  private browser: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private active = 0;

  constructor(
    private readonly logger: Logger,
    private readonly idleMs = 60_000,
  ) {}

  private async getBrowser(): Promise<Browser> {
    this.browser ??= chromium
      .launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] })
      .catch((error: unknown) => {
        this.browser = null;
        throw error;
      });
    return this.browser;
  }

  async render(html: string): Promise<Buffer> {
    this.active += 1;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.route('**/*', (route) =>
          route.request().url().startsWith('data:') ? route.continue() : route.abort(),
        );
        await page.setContent(html, { waitUntil: 'load' });
        return await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
        });
      } finally {
        await context.close();
      }
    } finally {
      this.active -= 1;
      if (this.active === 0) this.idleTimer = setTimeout(() => void this.close(), this.idleMs).unref();
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b !== null) {
      await (await b).close().catch(() => undefined);
      this.logger.debug('pdf browser closed');
    }
  }
}
