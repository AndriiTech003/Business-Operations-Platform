import type { PrismaClient } from '../generated/prisma/client';

export interface ReportFilter {
  tenantId: string;
  from: Date;
  to: Date;
  ownerId: string | null;
  pipelineId: string | null;
}

export class ReportsRepository {
  constructor(private readonly db: PrismaClient) {}

  async pipelineStages(f: ReportFilter) {
    return this.db.$queryRaw<
      Array<{
        stage_id: string;
        name: string;
        kind: string;
        position: number;
        probability: number;
        deals: bigint;
        total: bigint | null;
        avg_days: number | null;
        reached: bigint;
      }>
    >`
      WITH p AS (
        SELECT id FROM pipelines WHERE tenant_id = ${f.tenantId}::uuid AND (${f.pipelineId}::uuid IS NULL OR id = ${f.pipelineId}::uuid)
        ORDER BY is_default DESC, created_at ASC LIMIT 1
      ), st AS (
        SELECT id, name, kind::text AS kind, position, probability FROM stages
        WHERE tenant_id = ${f.tenantId}::uuid AND pipeline_id = (SELECT id FROM p)
      ), maxopen AS (
        SELECT COALESCE(max(position), 0) AS m FROM st WHERE kind = 'open'
      ), d AS (
        SELECT id, stage_id, amount_cents, stage_changed_at FROM deals
        WHERE tenant_id = ${f.tenantId}::uuid AND deleted_at IS NULL AND pipeline_id = (SELECT id FROM p)
          AND (${f.ownerId}::uuid IS NULL OR owner_id = ${f.ownerId}::uuid)
      ), visits AS (
        SELECT d.id AS deal_id, d.stage_id FROM d
        UNION ALL
        SELECT a.subject_id, (a.data->>'fromStageId')::uuid FROM activities a
        JOIN d ON d.id = a.subject_id
        WHERE a.tenant_id = ${f.tenantId}::uuid AND a.kind = 'deal.stage_changed' AND a.data ? 'fromStageId'
      ), furthest AS (
        SELECT v.deal_id,
          max(CASE WHEN st.kind = 'won' THEN (SELECT m FROM maxopen) + 1 WHEN st.kind = 'open' THEN st.position ELSE -1 END) AS f
        FROM visits v JOIN st ON st.id = v.stage_id
        GROUP BY v.deal_id
      )
      SELECT st.id::text AS stage_id, st.name, st.kind, st.position, st.probability,
        count(d.id) AS deals,
        sum(d.amount_cents)::bigint AS total,
        avg(EXTRACT(EPOCH FROM (now() - d.stage_changed_at)) / 86400)::float8 AS avg_days,
        CASE
          WHEN st.kind = 'open' THEN (SELECT count(*) FROM furthest WHERE furthest.f >= st.position)
          WHEN st.kind = 'won' THEN (SELECT count(*) FROM furthest WHERE furthest.f > (SELECT m FROM maxopen))
          ELSE count(d.id)
        END AS reached
      FROM st LEFT JOIN d ON d.stage_id = st.id
      GROUP BY st.id, st.name, st.kind, st.position, st.probability
      ORDER BY st.position`;
  }

  async pipelineSummary(f: ReportFilter) {
    const rows = await this.db.$queryRaw<
      Array<{ open_cents: bigint | null; open_deals: bigint; won_7d: bigint | null }>
    >`
      SELECT
        sum(amount_cents) FILTER (WHERE closed_at IS NULL)::bigint AS open_cents,
        count(*) FILTER (WHERE closed_at IS NULL) AS open_deals,
        sum(amount_cents) FILTER (WHERE closed_at >= now() - interval '7 days' AND stage_id IN (
          SELECT id FROM stages WHERE tenant_id = ${f.tenantId}::uuid AND kind = 'won'))::bigint AS won_7d
      FROM deals WHERE tenant_id = ${f.tenantId}::uuid AND deleted_at IS NULL
        AND (${f.ownerId}::uuid IS NULL OR owner_id = ${f.ownerId}::uuid)`;
    return rows[0];
  }

  async revenueByMonth(f: ReportFilter) {
    return this.db.$queryRaw<
      Array<{ month: string; won: bigint | null; invoiced: bigint | null; paid: bigint | null }>
    >`
      WITH months AS (
        SELECT to_char(m, 'YYYY-MM') AS month FROM generate_series(date_trunc('month', ${f.from}::timestamptz), date_trunc('month', ${f.to}::timestamptz), interval '1 month') m
      ), won AS (
        SELECT to_char(d.closed_at, 'YYYY-MM') AS month, sum(d.amount_cents) AS v FROM deals d
        JOIN stages s ON s.id = d.stage_id AND s.tenant_id = d.tenant_id AND s.kind = 'won'
        WHERE d.tenant_id = ${f.tenantId}::uuid AND d.deleted_at IS NULL AND d.closed_at BETWEEN ${f.from} AND ${f.to}
          AND (${f.ownerId}::uuid IS NULL OR d.owner_id = ${f.ownerId}::uuid)
        GROUP BY 1
      ), invoiced AS (
        SELECT to_char(issue_date, 'YYYY-MM') AS month, sum(total_cents) AS v FROM invoices
        WHERE tenant_id = ${f.tenantId}::uuid AND status <> 'draft' AND status <> 'void' AND issue_date BETWEEN ${f.from} AND ${f.to}
        GROUP BY 1
      ), paid AS (
        SELECT to_char(p.paid_at, 'YYYY-MM') AS month, sum(p.amount_cents) AS v FROM payments p
        WHERE p.tenant_id = ${f.tenantId}::uuid AND p.paid_at BETWEEN ${f.from} AND ${f.to}
        GROUP BY 1
      )
      SELECT months.month, won.v::bigint AS won, invoiced.v::bigint AS invoiced, paid.v::bigint AS paid
      FROM months LEFT JOIN won USING (month) LEFT JOIN invoiced USING (month) LEFT JOIN paid USING (month)
      ORDER BY months.month`;
  }

  async arAging(tenantId: string, asOf: Date) {
    return this.db.$queryRaw<
      Array<{ id: string; number: string; company: string | null; due_date: Date; days: number; balance: bigint }>
    >`
      SELECT i.id::text AS id, i.number, c.name AS company, i.due_date,
        GREATEST(0, floor(EXTRACT(EPOCH FROM (${asOf}::timestamptz - i.due_date)) / 86400))::int AS days,
        (i.total_cents - i.paid_cents)::bigint AS balance
      FROM invoices i LEFT JOIN companies c ON c.id = i.company_id AND c.tenant_id = i.tenant_id
      WHERE i.tenant_id = ${tenantId}::uuid AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.total_cents > i.paid_cents
      ORDER BY i.due_date ASC
      LIMIT 2000`;
  }

  async activityByUser(f: ReportFilter) {
    return this.db.$queryRaw<
      Array<{ user_id: string | null; activities: bigint; notes: bigint; tasks_completed: bigint; deals_won: bigint }>
    >`
      WITH a AS (
        SELECT actor_id AS user_id, count(*) AS activities, count(*) FILTER (WHERE kind IN ('note', 'call', 'email', 'meeting')) AS notes
        FROM activities WHERE tenant_id = ${f.tenantId}::uuid AND actor_type = 'user' AND created_at BETWEEN ${f.from} AND ${f.to}
          AND (${f.ownerId}::text IS NULL OR actor_id = ${f.ownerId}::text)
        GROUP BY actor_id
      ), t AS (
        SELECT assignee_id::text AS user_id, count(*) AS tasks_completed FROM tasks
        WHERE tenant_id = ${f.tenantId}::uuid AND status = 'done' AND completed_at BETWEEN ${f.from} AND ${f.to}
        GROUP BY assignee_id
      ), w AS (
        SELECT d.owner_id::text AS user_id, count(*) AS deals_won FROM deals d
        JOIN stages s ON s.id = d.stage_id AND s.tenant_id = d.tenant_id AND s.kind = 'won'
        WHERE d.tenant_id = ${f.tenantId}::uuid AND d.closed_at BETWEEN ${f.from} AND ${f.to}
        GROUP BY d.owner_id
      )
      SELECT COALESCE(a.user_id, t.user_id, w.user_id) AS user_id,
        COALESCE(a.activities, 0) AS activities, COALESCE(a.notes, 0) AS notes,
        COALESCE(t.tasks_completed, 0) AS tasks_completed, COALESCE(w.deals_won, 0) AS deals_won
      FROM a FULL OUTER JOIN t ON t.user_id = a.user_id FULL OUTER JOIN w ON w.user_id = COALESCE(a.user_id, t.user_id)`;
  }

  async activityByActorType(f: ReportFilter) {
    return this.db.$queryRaw<Array<{ actor_type: string; count: bigint }>>`
      SELECT actor_type, count(*) AS count FROM activities
      WHERE tenant_id = ${f.tenantId}::uuid AND created_at BETWEEN ${f.from} AND ${f.to}
      GROUP BY actor_type ORDER BY count DESC`;
  }
}
