import { init } from '@ashamrai/flags-node';
import type { Logger } from 'pino';

type FlagsClient = ReturnType<typeof init>;

export const FLAG_DEFAULTS: Record<string, boolean> = {
  'workflow-ai-step': true,
  'workflow-builder-v2': true,
  'fair-step-scheduling': true,
};

export class FlagsGateway {
  private client: FlagsClient | null = null;
  private ready = false;

  constructor(
    private readonly relayUrl: string | null,
    private readonly sdkKey: string | null,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.relayUrl === null || this.sdkKey === null) return;
    try {
      const quiet = {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => this.logger.debug({ args }, 'flags warning'),
        error: (...args: unknown[]) => this.logger.debug({ args }, 'flags error'),
      };
      this.client = init({ sdkKey: this.sdkKey, baseUrl: this.relayUrl, logger: quiet });
      const result = await this.client.waitForInitialization({ timeoutMs: 1500 });
      this.ready = result.initialized;
      if (!this.ready) this.logger.info('feature flag relay not reachable, using built-in defaults');
    } catch (error) {
      this.logger.info({ err: (error as Error).message }, 'feature flags disabled, using defaults');
      this.client = null;
    }
  }

  isEnabled(key: string, tenantId: string): boolean {
    const fallback = FLAG_DEFAULTS[key] ?? false;
    if (this.client === null) return fallback;
    try {
      return this.client.boolVariation(key, { kind: 'tenant', key: tenantId }, fallback);
    } catch {
      return fallback;
    }
  }

  async close(): Promise<void> {
    if (this.client !== null) await this.client.close().catch(() => undefined);
  }
}
