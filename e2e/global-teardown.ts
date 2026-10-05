import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { Redis } from 'ioredis';
import { ROOT, STATE_FILE, readState, stateExists } from './stack';

export default async function globalTeardown(): Promise<void> {
  if (!stateExists()) return;
  const state = readState();
  for (const pid of state.pids) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of state.pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
  const name = new URL(state.databaseUrl).pathname.slice(1);
  const admin = new pg.Client({ connectionString: state.databaseUrl.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  const redis = new Redis(state.redisUrl);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${state.redisPrefix}*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  redis.disconnect();
  rmSync(resolve(ROOT, 'apps/web/dist-e2e'), { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
}
