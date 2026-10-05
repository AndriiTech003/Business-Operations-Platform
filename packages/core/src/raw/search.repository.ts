import type { PrismaClient } from '../generated/prisma/client';

export interface SearchRow {
  entity: string;
  entity_id: string;
  title: string;
  subtitle: string | null;
  external: boolean;
  score: number;
}

export class SearchRepository {
  constructor(private readonly db: PrismaClient) {}

  async search(
    tenantId: string,
    query: string,
    entities: string[] | null,
    limitPerEntity: number,
  ): Promise<SearchRow[]> {
    const q = query.trim().slice(0, 200);
    if (q === '') return [];
    const prefix = q
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}@._-]/gu, ''))
      .filter((w) => w.length > 0)
      .map((w) => `${w.replace(/[&|!:*()<>']/g, '')}:*`)
      .join(' & ');
    const rows = await this.db.$queryRaw<SearchRow[]>`
      WITH matches AS (
        SELECT entity, entity_id::text AS entity_id, title, subtitle, external,
          GREATEST(
            CASE WHEN ${prefix} <> '' THEN ts_rank(tsv, to_tsquery('simple', ${prefix})) ELSE 0 END,
            similarity(title, ${q})
          )::float8 AS score
        FROM search_documents
        WHERE tenant_id = ${tenantId}::uuid
          AND (${entities === null} OR entity = ANY(${entities ?? []}::text[]))
          AND (
            (${prefix} <> '' AND tsv @@ to_tsquery('simple', ${prefix}))
            OR title % ${q}
            OR title ILIKE ${'%' + q.replace(/[%_]/g, '') + '%'}
          )
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY entity ORDER BY round(score::numeric, 3) DESC, title COLLATE "C" ASC, entity_id ASC
        ) AS rn FROM matches
      )
      SELECT entity, entity_id, title, subtitle, external, score FROM ranked WHERE rn <= ${limitPerEntity}
      ORDER BY round(score::numeric, 3) DESC, entity ASC, title COLLATE "C" ASC, entity_id ASC`;
    return rows;
  }
}
