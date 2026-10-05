import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Page as PageDto, RunDto, WorkflowDto } from '@bop/contracts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  NativeSelect,
  SkeletonRows,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Tooltip,
} from '@bop/ui';
import { FlaskConical, RefreshCw, Zap } from 'lucide-react';
import { Page, PageHeader } from '../../../components/PageHeader';
import { api, asList } from '../../../lib/api';
import { durationMs, fmtDateTime, relative } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import { usePollInterval } from '../../../lib/realtime';
import { StatusBadge } from './run-utils';

const route = getRouteApi('/app/runs');
const STATUSES = ['running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;

export function RunsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const interval = usePollInterval(10_000);
  const workflows = useQuery({
    queryKey: keys.workflows.list,
    queryFn: async () => asList<WorkflowDto>(await api.get('/v1/workflows')),
  });
  const params = {
    workflowId: search.workflowId,
    status: search.status,
    includeTests: search.tests ? 'true' : undefined,
  };
  const query = useInfiniteQuery({
    queryKey: keys.runs.list(params),
    queryFn: ({ pageParam }) =>
      api.get<PageDto<RunDto>>('/v1/workflow-runs', {
        query: { ...params, limit: 50, cursor: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? null,
    refetchInterval: interval === false ? 30_000 : interval,
  });
  const runs = query.data?.pages.flatMap((p) => p.items) ?? [];
  const setSearch = (next: typeof search) => void navigate({ to: '/runs', search: next, replace: true });
  return (
    <Page>
      <PageHeader
        icon={<Zap />}
        title="Workflow runs"
        description="Every execution with its version, trigger and step-by-step replay"
        actions={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()} loading={query.isRefetching}>
            <RefreshCw /> Refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="Workflow"
          className="h-8 w-64"
          value={search.workflowId ?? ''}
          onChange={(e) => setSearch({ ...search, workflowId: e.target.value || undefined })}
          data-testid="runs-filter-workflow"
        >
          <option value="">All workflows</option>
          {(workflows.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          className="h-8 w-40"
          value={search.status ?? ''}
          onChange={(e) => setSearch({ ...search, status: (e.target.value || undefined) as typeof search.status })}
          data-testid="runs-filter-status"
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={search.tests === true}
            onCheckedChange={(v) => setSearch({ ...search, tests: v ? true : undefined })}
            data-testid="runs-filter-tests"
          />{' '}
          Include test runs
        </label>
      </div>
      <Card className="min-h-0 flex-1 overflow-auto">
        {query.isLoading ? (
          <SkeletonRows rows={8} className="p-3" />
        ) : runs.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={<Zap />}
            title="No runs"
            description="Runs appear when a published workflow is triggered."
          />
        ) : (
          <Table data-testid="runs-table">
            <THead>
              <tr>
                <TH>Status</TH>
                <TH>Workflow</TH>
                <TH>Version</TH>
                <TH>Trigger</TH>
                <TH>Started</TH>
                <TH>Duration</TH>
                <TH>Error</TH>
              </tr>
            </THead>
            <TBody>
              {runs.map((r) => (
                <TR
                  key={r.id}
                  tabIndex={0}
                  className="cursor-pointer"
                  data-testid="run-row"
                  data-run-id={r.id}
                  onClick={() => void navigate({ to: '/runs/$id', params: { id: r.id } })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void navigate({ to: '/runs/$id', params: { id: r.id } });
                  }}
                >
                  <TD>
                    <div className="flex items-center gap-1">
                      <StatusBadge status={r.status} />
                      {r.isTest ? (
                        <Tooltip content="Test run">
                          <FlaskConical className="size-3.5 text-info" />
                        </Tooltip>
                      ) : null}
                    </div>
                  </TD>
                  <TD className="font-medium">
                    {r.workflowName ??
                      workflows.data?.find((w) => w.id === r.workflowId)?.name ??
                      r.workflowId.slice(0, 8)}
                  </TD>
                  <TD>
                    <Badge variant="outline">v{r.version}</Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{r.triggerType.replace('_', ' ')}</TD>
                  <TD>
                    <Tooltip content={fmtDateTime(r.startedAt)}>
                      <span className="text-xs">{relative(r.startedAt)}</span>
                    </Tooltip>
                  </TD>
                  <TD className="tabular-nums text-xs">
                    {r.durationMs !== null ? durationMs(r.durationMs) : r.status === 'waiting' ? 'waiting…' : '—'}
                  </TD>
                  <TD className="max-w-64 truncate text-xs text-destructive">{r.error?.message ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {query.hasNextPage ? (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}
