import { ENTITY_TABLES } from '@bop/workflow-core';
import type { TriggerEntity } from '@bop/contracts';
import type { PrismaClient } from '../generated/prisma/client';

const SOFT_DELETE: Record<TriggerEntity, boolean> = {
  company: true,
  contact: true,
  deal: true,
  invoice: false,
  task: false,
};

export class ConditionScanRepository {
  constructor(private readonly db: PrismaClient) {}

  async matchingIds(
    tenantId: string,
    workflowId: string,
    entity: TriggerEntity,
    compiled: { sql: string; params: unknown[] },
    limit: number,
  ): Promise<string[]> {
    const table = ENTITY_TABLES[entity];
    const n = compiled.params.length;
    const sql =
      `SELECT t.id::text AS id FROM "${table}" t WHERE t.tenant_id = $${n + 1}::uuid` +
      (SOFT_DELETE[entity] ? ' AND t.deleted_at IS NULL' : '') +
      ` AND (${compiled.sql})` +
      ` AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_id = $${n + 2}::uuid AND r.dedupe_key = t.id::text)` +
      ` ORDER BY t.id LIMIT $${n + 3}`;
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      sql,
      ...compiled.params,
      tenantId,
      workflowId,
      limit,
    );
    return rows.map((r) => r.id);
  }
}
