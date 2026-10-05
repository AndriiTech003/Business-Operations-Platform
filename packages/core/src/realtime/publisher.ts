import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { signJwt } from '../util/crypto';

export const channels = {
  deals: (tenantId: string) => `room:t.${tenantId}.deals`,
  record: (tenantId: string, entity: string, id: string) => `room:t.${tenantId}.rec.${entity}.${id}`,
  approvals: (tenantId: string) => `room:t.${tenantId}.approvals`,
  run: (tenantId: string, runId: string) => `room:t.${tenantId}.run.${runId}`,
  user: (userId: string) => `user:${userId}`,
};

export interface RealtimeOptions {
  url: string | null;
  serverKey: string;
  jwtSecret: string;
  redisPrefix: string;
}

export class RealtimePublisher {
  private downUntil = 0;

  constructor(
    private readonly options: RealtimeOptions,
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.options.url !== null;
  }

  async publish(channel: string, data: Record<string, unknown>): Promise<boolean> {
    await this.redis.publish(`${this.options.redisPrefix}:rt:${channel}`, JSON.stringify(data)).catch(() => 0);
    if (this.options.url === null || Date.now() < this.downUntil) return false;
    try {
      const res = await fetch(`${this.options.url}/v1/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.options.serverKey },
        body: JSON.stringify({ ch: channel, d: data, cmid: randomUUID() }),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, channel }, 'realtime publish rejected');
        return false;
      }
      return true;
    } catch (error) {
      this.downUntil = Date.now() + 5000;
      this.logger.warn({ err: (error as Error).message }, 'realtime server unavailable, falling back to polling');
      return false;
    }
  }

  toUser(userId: string, data: Record<string, unknown>): Promise<boolean> {
    return this.publish(channels.user(userId), data);
  }

  async ticket(user: { id: string; name: string; tenantId: string }): Promise<{ ticket: string; url: string } | null> {
    if (this.options.url === null) return null;
    const token = signJwt({ sub: user.id, name: user.name, tid: user.tenantId }, this.options.jwtSecret, 300);
    try {
      const res = await fetch(`${this.options.url}/v1/tickets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { ticket: string };
      const ws = this.options.url.replace(/^http/, 'ws');
      return { ticket: body.ticket, url: `${ws}/v1/connect` };
    } catch {
      return null;
    }
  }
}
