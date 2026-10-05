import type { PrismaClient } from '../generated/prisma/client';

const TABLES: Record<string, string> = { company: 'companies', contact: 'contacts', deal: 'deals' };
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export class RecordsQueryRepository {
  constructor(private readonly db: PrismaClient) {}

  async orderByCustom(
    tenantId: string,
    entity: string,
    ids: string[],
    key: string,
    numeric: boolean,
    direction: 'asc' | 'desc',
    limit: number,
    offset: number,
  ): Promise<string[]> {
    const table = TABLES[entity];
    if (table === undefined || !SAFE_KEY.test(key)) throw new Error('Invalid custom sort');
    if (ids.length === 0) return [];
    const expr = numeric ? `((custom->>'${key}')::numeric)` : `(custom->>'${key}')`;
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM "${table}" WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY ${expr} ${dir} NULLS LAST, id ASC LIMIT $3 OFFSET $4`,
      tenantId,
      ids,
      limit,
      offset,
    );
    return rows.map((r) => r.id);
  }
}
