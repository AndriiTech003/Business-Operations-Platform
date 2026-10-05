import type {
  ActivityReportDto,
  ArAgingReportDto,
  PipelineReportDto,
  ReportQuery,
  RevenueReportDto,
  SearchHit,
  SearchResult,
  SubjectType,
  TriggerEntity,
} from '@bop/contracts';
import { isExternalCompany, isExternalSource } from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { ReportsRepository, type ReportFilter } from '../raw/reports.repository';
import { SearchRepository } from '../raw/search.repository';
import { toNumber } from '../util/json';
import type { Directory } from './directory';

function filter(q: ReportQuery, defaultMonths = 12): ReportFilter {
  const to = q.to !== undefined ? new Date(q.to) : new Date();
  const from =
    q.from !== undefined
      ? new Date(q.from)
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - defaultMonths + 1, 1));
  return { tenantId: requireTenantId(), from, to, ownerId: q.ownerId ?? null, pipelineId: q.pipelineId ?? null };
}

export class ReportsService {
  private readonly repo: ReportsRepository;

  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
  ) {
    this.repo = new ReportsRepository(deps.db.system);
  }

  private async currency(): Promise<string> {
    const t = await this.deps.db.system.tenant.findUnique({ where: { id: requireTenantId() } });
    return ((t?.settings ?? {}) as { currency?: string }).currency ?? 'USD';
  }

  async pipeline(
    q: ReportQuery,
  ): Promise<PipelineReportDto & { summary: { openCents: number; openDeals: number; wonLast7DaysCents: number } }> {
    const f = filter(q);
    const [rows, summary] = await Promise.all([this.repo.pipelineStages(f), this.repo.pipelineSummary(f)]);
    const open = rows.filter((r) => r.kind === 'open');
    return {
      stages: rows.map((r) => {
        const idx = open.findIndex((o) => o.stage_id === r.stage_id);
        const next = idx >= 0 ? (open[idx + 1] ?? rows.find((x) => x.kind === 'won')) : undefined;
        const reached = Number(r.reached);
        return {
          stageId: r.stage_id,
          name: r.name,
          kind: r.kind,
          deals: Number(r.deals),
          totalCents: toNumber(r.total),
          weightedCents: Math.round((toNumber(r.total) * r.probability) / 100),
          avgDaysInStage: Math.round((r.avg_days ?? 0) * 10) / 10,
          reached,
          conversionToNext:
            next === undefined || reached === 0 ? null : Math.round((Number(next.reached) / reached) * 1000) / 10,
        };
      }),
      summary: {
        openCents: toNumber(summary?.open_cents ?? 0n),
        openDeals: Number(summary?.open_deals ?? 0n),
        wonLast7DaysCents: toNumber(summary?.won_7d ?? 0n),
      },
    };
  }

  async revenue(q: ReportQuery): Promise<RevenueReportDto> {
    const rows = await this.repo.revenueByMonth(filter(q));
    return {
      currency: await this.currency(),
      months: rows.map((r) => ({
        month: r.month,
        wonCents: toNumber(r.won),
        invoicedCents: toNumber(r.invoiced),
        paidCents: toNumber(r.paid),
      })),
    };
  }

  async arAging(): Promise<ArAgingReportDto> {
    const rows = await this.repo.arAging(requireTenantId(), new Date());
    const bucketOf = (days: number): '0-30' | '31-60' | '61-90' | '90+' =>
      days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    const buckets = new Map<string, { invoices: number; balanceCents: number }>(
      ['0-30', '31-60', '61-90', '90+'].map((b) => [b, { invoices: 0, balanceCents: 0 }]),
    );
    const out = rows.map((r) => {
      const bucket = bucketOf(r.days);
      const b = buckets.get(bucket) as { invoices: number; balanceCents: number };
      b.invoices += 1;
      b.balanceCents += toNumber(r.balance);
      return {
        invoiceId: r.id,
        number: r.number,
        company: r.company ?? '',
        dueDate: r.due_date.toISOString(),
        daysOverdue: r.days,
        balanceCents: toNumber(r.balance),
        bucket,
      };
    });
    return {
      currency: await this.currency(),
      buckets: [...buckets.entries()].map(([bucket, v]) => ({ bucket: bucket as '0-30', ...v })),
      rows: out,
    };
  }

  async activity(q: ReportQuery): Promise<ActivityReportDto> {
    const f = filter(q, 3);
    const [rows, byType] = await Promise.all([this.repo.activityByUser(f), this.repo.activityByActorType(f)]);
    const users = await this.directory.usersById(rows.map((r) => r.user_id));
    return {
      users: rows.map((r) => ({
        userId: r.user_id,
        name: r.user_id === null ? 'Unassigned' : (users.get(r.user_id)?.name ?? 'Former member'),
        activities: Number(r.activities),
        notes: Number(r.notes),
        tasksCompleted: Number(r.tasks_completed),
        dealsWon: Number(r.deals_won),
      })),
      byActorType: byType.map((r) => ({ actorType: r.actor_type, count: Number(r.count) })),
    };
  }
}

const FREE_TEXT_SUBTITLES = new Set(['company', 'contact', 'invoice']);

export class SearchService {
  private readonly repo: SearchRepository;

  constructor(private readonly deps: CoreDeps) {
    this.repo = new SearchRepository(deps.db.system);
  }

  async search(query: string, types: SubjectType[] | null, limitPerEntity = 5): Promise<SearchResult> {
    const rows = await this.repo.search(requireTenantId(), query, types, limitPerEntity);
    const groups = new Map<SubjectType, SearchHit[]>();
    for (const r of rows) {
      const untrusted = [
        ...(r.external ? ['title'] : []),
        ...(r.subtitle !== null && (r.external || FREE_TEXT_SUBTITLES.has(r.entity)) ? ['subtitle'] : []),
      ];
      const hit: SearchHit = {
        entity: r.entity as SubjectType,
        id: r.entity_id,
        title: r.title,
        subtitle: r.subtitle,
        score: Math.round(r.score * 1000) / 1000,
        ...(untrusted.length > 0 ? { untrusted } : {}),
      };
      const list = groups.get(hit.entity) ?? [];
      list.push(hit);
      groups.set(hit.entity, list);
    }
    return { query, groups: [...groups.entries()].map(([entity, hits]) => ({ entity, hits })) };
  }

  async index(entity: TriggerEntity, id: string): Promise<void> {
    const tenantId = requireTenantId();
    const db = this.deps.db.scoped;
    let doc: { title: string; subtitle: string | null; body: string; external?: boolean } | null = null;
    let deleted = false;
    switch (entity) {
      case 'company': {
        const c = await db.company.findFirst({ where: { id } });
        if (c === null || c.deletedAt !== null) deleted = true;
        else
          doc = {
            title: c.name,
            subtitle: c.domain ?? c.industry,
            body: [c.industry, c.tags.join(' '), JSON.stringify(c.custom)].join(' '),
            external: isExternalCompany(c),
          };
        break;
      }
      case 'contact': {
        const c = await db.contact.findFirst({ where: { id } });
        if (c === null || c.deletedAt !== null) deleted = true;
        else
          doc = {
            title: `${c.firstName} ${c.lastName}`.trim(),
            subtitle: c.email ?? c.title,
            body: [c.title, c.phone, c.email, c.tags.join(' ')].join(' '),
            external: isExternalSource(c.source),
          };
        break;
      }
      case 'deal': {
        const d = await db.deal.findFirst({ where: { id } });
        if (d === null || d.deletedAt !== null) deleted = true;
        else
          doc = {
            title: d.title,
            subtitle: `${(Number(d.amountCents) / 100).toFixed(2)} ${d.currency}`,
            body: d.tags.join(' '),
          };
        break;
      }
      case 'invoice': {
        const i = await db.invoice.findFirst({ where: { id } });
        if (i === null) deleted = true;
        else {
          const company = await db.company.findFirst({
            where: { id: i.companyId },
            select: { name: true, source: true, tags: true },
          });
          doc = {
            title: i.number,
            subtitle: `${company?.name ?? ''} · ${i.status}`,
            body: i.notes ?? '',
            external: company !== null && isExternalCompany(company),
          };
        }
        break;
      }
      case 'task': {
        const t = await db.task.findFirst({ where: { id } });
        if (t === null) deleted = true;
        else doc = { title: t.title, subtitle: t.status, body: t.description ?? '' };
        break;
      }
    }
    if (deleted || doc === null) {
      await db.searchDocument.deleteMany({ where: { entity, entityId: id } });
      return;
    }
    await db.searchDocument.upsert({
      where: { tenantId_entity_entityId: { tenantId, entity, entityId: id } },
      create: {
        tenantId,
        entity,
        entityId: id,
        title: doc.title,
        subtitle: doc.subtitle,
        body: doc.body,
        external: doc.external === true,
        updatedAt: new Date(),
      },
      update: {
        title: doc.title,
        subtitle: doc.subtitle,
        body: doc.body,
        external: doc.external === true,
        updatedAt: new Date(),
      },
    });
  }
}
