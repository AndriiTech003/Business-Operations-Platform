import type { PrismaClient } from '../generated/prisma/client';

const TABLES: Record<string, string> = { company: 'companies', contact: 'contacts', deal: 'deals' };
const SAFE = /^[a-zA-Z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CustomFieldIndexRepository {
  constructor(private readonly db: PrismaClient) {}

  indexName(tenantId: string, entity: string, key: string): string {
    return `cf_${entity}_${tenantId.replace(/-/g, '').slice(0, 12)}_${key}`.slice(0, 63).toLowerCase();
  }

  async createIndex(tenantId: string, entity: string, key: string, type: string): Promise<string> {
    const table = TABLES[entity];
    if (table === undefined || !SAFE.test(key) || !UUID.test(tenantId)) throw new Error('Invalid index request');
    const name = this.indexName(tenantId, entity, key);
    const expr = type === 'number' || type === 'money' ? `(((custom->>'${key}'))::numeric)` : `((custom->>'${key}'))`;
    await this.db.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ${expr} WHERE tenant_id = '${tenantId}'::uuid`,
    );
    return name;
  }

  async dropIndex(name: string): Promise<void> {
    if (!SAFE.test(name)) throw new Error('Invalid index name');
    await this.db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  }

  async indexExists(name: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM pg_indexes WHERE indexname = ${name}`;
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async explainUsesIndex(tenantId: string, entity: string, key: string, value: string): Promise<string> {
    const table = TABLES[entity];
    if (table === undefined || !SAFE.test(key)) throw new Error('Invalid request');
    await this.db.$executeRawUnsafe('SET enable_seqscan = off');
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT id FROM "${table}" WHERE tenant_id = $1::uuid AND (custom->>'${key}') = $2`,
        tenantId,
        value,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await this.db.$executeRawUnsafe('SET enable_seqscan = on');
    }
  }
}
