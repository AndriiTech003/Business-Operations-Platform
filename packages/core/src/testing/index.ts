import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDatabase, dropDatabase, migrateDatabase, withDatabase } from '../db/admin';

export interface TestResources {
  id: string;
  adminUrl: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  mailpitUrl: string;
  smtpUrl: string;
  s3Endpoint: string;
  drop(): Promise<void>;
}

export async function createTestResources(label = 'run'): Promise<TestResources> {
  const id = `${label}_${randomBytes(4).toString('hex')}`;
  let adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://127.0.0.1:5432/postgres';
  let redisUrl = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/5';
  const stops: Array<() => Promise<unknown>> = [];
  if (process.env['TESTCONTAINERS'] === '1') {
    const pgModule = '@testcontainers/postgresql';
    const redisModule = '@testcontainers/redis';
    const { PostgreSqlContainer } = (await import(pgModule)) as {
      PostgreSqlContainer: new (image: string) => {
        start(): Promise<{ getConnectionUri(): string; stop(): Promise<unknown> }>;
      };
    };
    const { RedisContainer } = (await import(redisModule)) as {
      RedisContainer: new (image: string) => {
        start(): Promise<{ getConnectionUrl(): string; stop(): Promise<unknown> }>;
      };
    };
    const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
    const redis = await new RedisContainer('redis:8-alpine').start();
    stops.push(
      () => pg.stop(),
      () => redis.stop(),
    );
    adminUrl = withDatabase(pg.getConnectionUri(), 'postgres');
    redisUrl = redis.getConnectionUrl();
  }
  const name = `bop_test_${id}`;
  await createDatabase(adminUrl, name);
  const databaseUrl = withDatabase(adminUrl, name);
  await migrateDatabase(databaseUrl);
  return {
    id,
    adminUrl,
    databaseUrl,
    redisUrl,
    redisPrefix: `bop_test_${id}`,
    mailpitUrl: process.env['TEST_MAILPIT_URL'] ?? 'http://127.0.0.1:8025',
    smtpUrl: process.env['TEST_SMTP_URL'] ?? 'smtp://127.0.0.1:1025',
    s3Endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9002',
    async drop() {
      await dropDatabase(adminUrl, name).catch(() => undefined);
      await deletePrefix(redisUrl, `bop_test_${id}`).catch(() => undefined);
      for (const stop of stops) await stop();
    },
  };
}

export async function deletePrefix(redisUrl: string, prefix: string): Promise<number> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  let deleted = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
      cursor = next;
      if (keys.length > 0) deleted += await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
  return deleted;
}

export function testEnv(r: TestResources, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: r.databaseUrl,
    REDIS_URL: r.redisUrl,
    REDIS_PREFIX: r.redisPrefix,
    SMTP_URL: r.smtpUrl,
    S3_ENDPOINT: r.s3Endpoint,
    S3_PREFIX: `test/${r.id}/`,
    LOG_LEVEL: 'warn',
    ...extra,
  };
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  MessageID: string;
}

export async function mailpitSearch(mailpitUrl: string, query: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(query)}&limit=200`);
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms${last instanceof Error ? `: ${last.message}` : ''}`);
}
