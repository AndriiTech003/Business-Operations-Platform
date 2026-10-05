import { useMemo } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ActivityReportDto, ArAgingReportDto, PipelineReportDto, RevenueReportDto } from '@bop/contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  NativeSelect,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@bop/ui';
import type { EChartsOption } from 'echarts';
import { ChartBar } from 'lucide-react';
import { format, parse, startOfYear, subDays, subMonths } from 'date-fns';
import { Page, PageHeader } from '../../components/PageHeader';
import { PanelBoundary } from '../../components/PanelBoundary';
import { api, errorMessage } from '../../lib/api';
import { useMembers, usePipelines } from '../../lib/data';
import { compactMoney, fmtDate, money, toIsoDateInput } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useMe } from '../../app/auth';
import { EChart, INK, SERIES } from './EChart';

const route = getRouteApi('/app/reports');
type Period = '30d' | '90d' | '12m' | 'ytd' | 'custom';

function day(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function range(period: Period, from?: string, to?: string): { from?: string; to?: string } {
  const now = new Date();
  switch (period) {
    case '30d':
      return { from: day(subDays(now, 30)), to: day(now) };
    case '90d':
      return { from: day(subDays(now, 90)), to: day(now) };
    case 'ytd':
      return { from: day(startOfYear(now)), to: day(now) };
    case 'custom':
      return { from: from || undefined, to: to || undefined };
    default:
      return { from: day(subMonths(now, 12)), to: day(now) };
  }
}

function useReport<T>(name: string, params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.reports(name, params),
    queryFn: () => api.get<T>(`/v1/reports/${name}`, { query: params }),
  });
}

function ChartCard({
  title,
  description,
  children,
  loading,
  error,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  loading: boolean;
  error: unknown;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72" />
        ) : error ? (
          <EmptyState title="Could not load report" description={errorMessage(error)} />
        ) : (
          <PanelBoundary>{children}</PanelBoundary>
        )}
      </CardContent>
    </Card>
  );
}

const axisCommon = {
  axisLine: { lineStyle: { color: INK.grid } },
  axisTick: { show: false },
  axisLabel: { color: INK.secondary, fontSize: 11 },
  splitLine: { lineStyle: { color: INK.grid, type: 'dashed' as const } },
};

function monthLabel(m: string) {
  try {
    return format(parse(m.slice(0, 7), 'yyyy-MM', new Date()), 'MMM yy');
  } catch {
    return m;
  }
}

function Funnel({ data, currency }: { data: PipelineReportDto; currency: string }) {
  const open = data.stages;
  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${String(v)} deals` },
      grid: { left: 90, right: 24, top: 8, bottom: 24 },
      xAxis: { type: 'value', ...axisCommon },
      yAxis: {
        type: 'category',
        inverse: true,
        data: open.map((s) => s.name),
        ...axisCommon,
        splitLine: { show: false },
      },
      series: [
        {
          name: 'Deals that reached the stage',
          type: 'bar',
          data: open.map((s) => s.reached),
          barMaxWidth: 22,
          itemStyle: { color: SERIES[0], borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', color: INK.secondary, fontSize: 11 },
        },
      ],
    }),
    [open],
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EChart
        option={option}
        height={Math.max(220, open.length * 44)}
        ariaLabel="Deals reaching each pipeline stage"
        testId="chart-funnel"
      />
      <table className="w-full text-sm" data-testid="funnel-table">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 text-left font-medium">Stage</th>
            <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Open deals</th>
            <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Value</th>
            <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Conversion →</th>
            <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Avg days</th>
          </tr>
        </thead>
        <tbody>
          {open.map((s) => (
            <tr key={s.stageId} className="border-b last:border-0">
              <td className="py-1.5">{s.name}</td>
              <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">{s.deals}</td>
              <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                {compactMoney(s.totalCents, currency)}
              </td>
              <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                {s.conversionToNext === null ? '—' : `${Math.round(s.conversionToNext)}%`}
              </td>
              <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">{s.avgDaysInStage.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Revenue({ data }: { data: RevenueReportDto }) {
  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v) => money(Number(v) * 100, data.currency),
      },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: INK.secondary } },
      grid: { left: 56, right: 16, top: 36, bottom: 28 },
      xAxis: {
        type: 'category',
        data: data.months.map((m) => monthLabel(m.month)),
        ...axisCommon,
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => compactMoney(v * 100, data.currency) },
      },
      series: (
        [
          ['Won deals', 'wonCents'],
          ['Invoiced', 'invoicedCents'],
          ['Paid', 'paidCents'],
        ] as const
      ).map(([name, key], i) => ({
        name,
        type: 'bar' as const,
        barMaxWidth: 14,
        barGap: '15%',
        itemStyle: { color: SERIES[i], borderRadius: [4, 4, 0, 0] },
        data: data.months.map((m) => m[key] / 100),
      })),
    }),
    [data],
  );
  const totals = data.months.reduce(
    (a, m) => ({ won: a.won + m.wonCents, inv: a.inv + m.invoicedCents, paid: a.paid + m.paidCents }),
    { won: 0, inv: 0, paid: 0 },
  );
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ['Won', totals.won],
            ['Invoiced', totals.inv],
            ['Paid', totals.paid],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold tabular-nums">{money(v, data.currency)}</p>
          </div>
        ))}
      </div>
      <EChart option={option} height={320} ariaLabel="Won, invoiced and paid revenue by month" testId="chart-revenue" />
    </div>
  );
}

function Aging({ data }: { data: ArAgingReportDto }) {
  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v) => money(Number(v) * 100, data.currency),
      },
      grid: { left: 56, right: 16, top: 12, bottom: 28 },
      xAxis: {
        type: 'category',
        data: data.buckets.map((b) => `${b.bucket} days`),
        ...axisCommon,
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => compactMoney(v * 100, data.currency) },
      },
      series: [
        {
          name: 'Outstanding',
          type: 'bar',
          barMaxWidth: 48,
          data: data.buckets.map((b, i) => ({
            value: b.balanceCents / 100,
            itemStyle: {
              color: ['#9ec5f0', '#5d9be3', '#2a78d6', '#184f94'][i] ?? SERIES[0],
              borderRadius: [4, 4, 0, 0],
            },
          })),
          label: {
            show: true,
            position: 'top',
            color: INK.secondary,
            fontSize: 11,
            formatter: (p) => compactMoney(Number(p.value) * 100, data.currency),
          },
        },
      ],
    }),
    [data],
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EChart option={option} height={300} ariaLabel="Receivables by days overdue" testId="chart-aging" />
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm" data-testid="aging-table">
          <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 text-left font-medium">Invoice</th>
              <th className="py-1.5 text-left font-medium">Company</th>
              <th className="py-1.5 text-left font-medium">Due</th>
              <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Days overdue</th>
              <th className="py-1.5 pl-3 text-right whitespace-nowrap font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted-foreground">
                  Nothing outstanding
                </td>
              </tr>
            ) : null}
            {data.rows.map((r) => (
              <tr key={r.invoiceId} className="border-b last:border-0">
                <td className="py-1.5">
                  <Link to="/invoices/$id" params={{ id: r.invoiceId }} className="text-primary hover:underline">
                    {r.number}
                  </Link>
                </td>
                <td className="py-1.5">{r.company}</td>
                <td className="py-1.5">{fmtDate(r.dueDate)}</td>
                <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">{r.daysOverdue}</td>
                <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {money(r.balanceCents, data.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Activity({ data }: { data: ActivityReportDto }) {
  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: INK.secondary } },
      grid: { left: 110, right: 16, top: 36, bottom: 24 },
      xAxis: { type: 'value', ...axisCommon },
      yAxis: {
        type: 'category',
        inverse: true,
        data: data.users.map((u) => u.name),
        ...axisCommon,
        splitLine: { show: false },
      },
      series: (
        [
          ['Activities', 'activities'],
          ['Notes', 'notes'],
          ['Tasks completed', 'tasksCompleted'],
          ['Deals won', 'dealsWon'],
        ] as const
      ).map(([name, key], i) => ({
        name,
        type: 'bar' as const,
        barMaxWidth: 10,
        itemStyle: { color: SERIES[i], borderRadius: [0, 4, 4, 0] },
        data: data.users.map((u) => u[key]),
      })),
    }),
    [data],
  );
  const total = data.byActorType.reduce((s, a) => s + a.count, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <EChart
        option={option}
        height={Math.max(240, data.users.length * 56 + 60)}
        ariaLabel="Team activity per user"
        testId="chart-activity"
      />
      <div className="grid content-start gap-2">
        <p className="text-xs font-medium text-muted-foreground">Who did the work</p>
        {data.byActorType.map((a) => (
          <div key={a.actorType} className="grid gap-1">
            <div className="flex justify-between text-sm">
              <span className="capitalize">{a.actorType}</span>
              <span className="tabular-nums text-muted-foreground">
                {a.count} · {total > 0 ? Math.round((a.count / total) * 100) : 0}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-2 rounded-full"
                style={{ width: `${total > 0 ? (a.count / total) * 100 : 0}%`, background: SERIES[0] }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReportsPage() {
  const me = useMe();
  const search = route.useSearch();
  const navigate = useNavigate();
  const { data: members } = useMembers();
  const { data: pipelines } = usePipelines();
  const period: Period = search.period ?? '12m';
  const r = range(period, search.from, search.to);
  const params = { from: r.from, to: r.to, ownerId: search.ownerId, pipelineId: search.pipelineId };
  const currency = me.tenant.settings.currency;
  const pipeline = useReport<PipelineReportDto>('pipeline', params);
  const revenue = useReport<RevenueReportDto>('revenue', params);
  const aging = useReport<ArAgingReportDto>('ar-aging', {});
  const activity = useReport<ActivityReportDto>('activity', params);
  const setSearch = (next: typeof search) => void navigate({ to: '/reports', search: next, replace: true });
  return (
    <Page>
      <PageHeader icon={<ChartBar />} title="Reports" description="Pipeline, revenue, receivables and team activity" />
      <div className="flex flex-wrap items-end gap-2" data-testid="report-filters">
        <NativeSelect
          aria-label="Period"
          className="h-8 w-40"
          value={period}
          onChange={(e) => setSearch({ ...search, period: e.target.value as Period })}
        >
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="12m">Last 12 months</option>
          <option value="ytd">Year to date</option>
          <option value="custom">Custom…</option>
        </NativeSelect>
        {period === 'custom' ? (
          <>
            <Input
              aria-label="From"
              type="date"
              className="h-8 w-40"
              value={search.from ?? toIsoDateInput(subMonths(new Date(), 3).toISOString())}
              onChange={(e) => setSearch({ ...search, from: e.target.value })}
            />
            <Input
              aria-label="To"
              type="date"
              className="h-8 w-40"
              value={search.to ?? toIsoDateInput(new Date().toISOString())}
              onChange={(e) => setSearch({ ...search, to: e.target.value })}
            />
          </>
        ) : null}
        <NativeSelect
          aria-label="Owner"
          className="h-8 w-44"
          value={search.ownerId ?? ''}
          onChange={(e) => setSearch({ ...search, ownerId: e.target.value || undefined })}
        >
          <option value="">Everyone</option>
          {(members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </NativeSelect>
        {(pipelines?.length ?? 0) > 1 ? (
          <NativeSelect
            aria-label="Pipeline"
            className="h-8 w-44"
            value={search.pipelineId ?? ''}
            onChange={(e) => setSearch({ ...search, pipelineId: e.target.value || undefined })}
          >
            <option value="">Default pipeline</option>
            {pipelines?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="receivables">Receivables</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="grid gap-4 xl:grid-cols-2">
          <ChartCard
            title="Pipeline funnel"
            description="Deals that reached each stage, stage-to-stage conversion and average days in stage"
            loading={pipeline.isLoading}
            error={pipeline.error}
          >
            {pipeline.data ? <Funnel data={pipeline.data} currency={currency} /> : null}
          </ChartCard>
          <ChartCard
            title="Revenue by month"
            description="Won deal value vs invoiced vs paid"
            loading={revenue.isLoading}
            error={revenue.error}
          >
            {revenue.data ? <Revenue data={revenue.data} /> : null}
          </ChartCard>
          <div className="xl:col-span-2">
            <ChartCard
              title="Team activity"
              description="Activities, notes, completed tasks and won deals per person; share of work by people, workflows, the AI agent and the system"
              loading={activity.isLoading}
              error={activity.error}
            >
              {activity.data ? <Activity data={activity.data} /> : null}
            </ChartCard>
          </div>
        </TabsContent>
        <TabsContent value="receivables">
          <ChartCard
            title="AR aging"
            description="Outstanding balances by days past due"
            loading={aging.isLoading}
            error={aging.error}
          >
            {aging.data ? <Aging data={aging.data} /> : null}
          </ChartCard>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
