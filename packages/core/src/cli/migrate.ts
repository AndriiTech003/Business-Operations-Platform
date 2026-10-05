import { ensureDatabase, migrateDatabase } from '../db/admin';
import { loadConfig } from '../config';

const config = loadConfig();
const created = await ensureDatabase(config.databaseUrl);
await migrateDatabase(config.databaseUrl);
console.log(`migrations applied${created ? ' (database created)' : ''}`);
