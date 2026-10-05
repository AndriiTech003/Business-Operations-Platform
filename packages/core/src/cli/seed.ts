import { databaseName, dropDatabase, ensureDatabase, migrateDatabase, withDatabase } from '../db/admin';
import { loadConfig } from '../config';
import { Core } from '../core';
import { DEMO_PASSWORD, DEMO_USERS, seedDemo } from '../seed/demo';

const config = loadConfig();
const reset = process.argv.includes('--reset');
if (reset) await dropDatabase(withDatabase(config.databaseUrl, 'postgres'), databaseName(config.databaseUrl));
await ensureDatabase(config.databaseUrl);
await migrateDatabase(config.databaseUrl);
const core = new Core({ service: 'seed' });
try {
  const existing = await core.deps.db.system.tenant.findUnique({ where: { slug: 'acme' } });
  if (existing !== null) {
    console.log('demo tenant already exists (use --reset to recreate)');
  } else {
    const result = await seedDemo(core);
    console.log(
      JSON.stringify(
        { seeded: result.counts, tenantId: result.tenantId, workflows: Object.keys(result.workflows).length },
        null,
        2,
      ),
    );
    console.log(`login: ${DEMO_USERS.map((u) => `${u.email} (${u.role})`).join(', ')} / password ${DEMO_PASSWORD}`);
  }
} finally {
  await core.close();
}
