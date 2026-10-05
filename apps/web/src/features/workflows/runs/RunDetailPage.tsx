import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { TRIGGER_NODE_ID, type RunDetailDto, type StepRunDto } from '@bop/contracts';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@bop/ui';
import { ChevronLeft, CircleStop, FlaskConical, PencilRuler, Zap } from 'lucide-react';
import { useAuth, useMe } from '../../../app/auth';
import { api, errorMessage } from '../../../lib/api';
import { durationMs, fmtDateTime } from '../../../lib/format';
import { keys } from '../../../lib/query-keys';
import { channels, useChannel } from '../../../lib/realtime';
import { PanelBoundary } from '../../../components/PanelBoundary';
import { Canvas } from '../builder/Canvas';
import { isVerticalLayout } from '../builder/definition';
import { Json, StepDetail } from './StepDetail';
import { StatusBadge, isTerminal, nodeStatuses, stepsByNode, traversedSet } from './run-utils';

const route = getRouteApi('/app/runs/$id');

function RunView({ run }: { run: RunDetailDto }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = route.useSearch();
  const selected = search.node ?? null;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const statuses = useMemo(() => nodeStatuses(run.steps), [run.steps]);
  const traversed = useMemo(() => traversedSet(run), [run]);
  const byNode = useMemo(() => stepsByNode(run.steps), [run.steps]);
  const select = (id: string | null) =>
    void navigate({ to: '/runs/$id', params: { id: run.id }, search: id ? { node: id } : {}, replace: true });

  const cancel = useMutation({
    mutationFn: () => api.post(`/v1/workflow-runs/${run.id}/cancel`, {}),
    onSuccess: () => {
      toast.success('Run cancelled');
      void qc.invalidateQueries({ queryKey: keys.runs.all });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: (step: StepRunDto) => api.post(`/v1/workflow-runs/${run.id}/steps/${step.id}/retry`, {}),
    onSuccess: () => {
      toast.success('Step scheduled for retry');
      void qc.invalidateQueries({ queryKey: keys.runs.detail(run.id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const failed = run.steps.find((s) => s.status === 'failed');
  const writable = can('workflows:write');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-detail" data-run-status={run.status}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
        <Link to="/runs" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Back to runs">
          <ChevronLeft className="size-4" />
        </Link>
        <Zap className="size-4 text-primary" />
        <span className="font-semibold">{run.workflowName ?? 'Workflow run'}</span>
        <Badge variant="outline">v{run.version}</Badge>
        <StatusBadge status={run.status} />
        {run.isTest ? (
          <Badge variant="info">
            <FlaskConical /> test
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          started {fmtDateTime(run.startedAt)}
          {run.durationMs !== null ? ` · ${durationMs(run.durationMs)}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {failed && writable ? (
            <Button
              size="sm"
              variant="outline"
              loading={retry.isPending}
              onClick={() => retry.mutate(failed)}
              data-testid="retry-failed-step"
            >
              Retry failed step
            </Button>
          ) : null}
          {!isTerminal(run.status) && writable ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmCancel(true)} data-testid="cancel-run">
              <CircleStop /> Cancel run
            </Button>
          ) : null}
          <Button size="sm" variant="outline" asChild>
            <Link
              to="/workflows/$id"
              params={{ id: run.workflowId }}
              search={{ runId: run.id }}
              data-testid="open-in-builder"
            >
              <PencilRuler /> Open {run.isTest ? 'test run' : 'run'} in builder
            </Link>
          </Button>
        </div>
      </div>
      {run.error ? (
        <p className="border-b bg-destructive/5 px-4 py-1.5 text-xs text-destructive">
          {run.error.nodeId ? `${run.error.nodeId}: ` : ''}
          {run.error.message}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <PanelBoundary>
            <Canvas
              definition={run.definition}
              statuses={statuses}
              traversed={traversed}
              selectedId={selected}
              onSelect={select}
              readOnly
              vertical={isVerticalLayout(run.definition)}
            />
          </PanelBoundary>
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5 rounded-lg border bg-card/90 px-2 py-1 text-[11px] shadow-sm">
            {(['succeeded', 'failed', 'running', 'waiting', 'skipped', 'cancelled'] as const).map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span
                  className={`size-2 rounded-full ${s === 'succeeded' ? 'bg-success' : s === 'failed' ? 'bg-destructive' : s === 'running' ? 'bg-info' : s === 'waiting' ? 'bg-warning' : 'bg-muted-foreground/50'}`}
                />
                {s}
              </span>
            ))}
          </div>
        </div>
        <aside className="w-[420px] shrink-0 overflow-y-auto border-l bg-card p-4">
          {selected === null || selected === TRIGGER_NODE_ID ? (
            <Tabs defaultValue="payload">
              <TabsList>
                <TabsTrigger value="payload">Trigger payload</TabsTrigger>
                <TabsTrigger value="context">Context</TabsTrigger>
              </TabsList>
              <TabsContent value="payload">
                <p className="mb-2 text-xs text-muted-foreground">
                  Click a node on the graph to inspect its input, output, error and attempts.
                </p>
                <Json value={run.triggerPayload} className="max-h-[60vh]" />
              </TabsContent>
              <TabsContent value="context">
                <Json value={run.context} className="max-h-[60vh]" />
              </TabsContent>
            </Tabs>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm font-semibold">{selected}</p>
                <Badge variant="secondary">{run.definition.nodes.find((n) => n.id === selected)?.type}</Badge>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => select(null)}>
                  Close
                </Button>
              </div>
              <StepDetail
                steps={byNode.get(selected) ?? []}
                onRetry={writable ? (s) => retry.mutate(s) : undefined}
                retrying={retry.isPending}
              />
            </div>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="Pending and waiting steps are cancelled; running steps receive an abort signal."
        destructive
        confirmLabel="Cancel run"
        confirmTestId="confirm-cancel-run"
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}

export function RunDetailPage() {
  const { id } = route.useParams();
  const me = useMe();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.runs.detail(id),
    queryFn: () => api.get<RunDetailDto>(`/v1/workflow-runs/${id}`),
    refetchInterval: (q) =>
      isTerminal(q.state.data?.status) ? false : q.state.data?.status === 'waiting' ? 5000 : 1500,
  });
  useChannel(channels.run(me.tenant.id, id), {
    onMessage: () => void qc.invalidateQueries({ queryKey: keys.runs.detail(id) }),
  });
  if (query.isLoading) return <Skeleton className="m-4 h-[80vh]" />;
  if (query.isError || query.data === undefined)
    return (
      <EmptyState
        className="m-6"
        icon={<Zap />}
        title="Run not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  return (
    <ReactFlowProvider>
      <RunView run={query.data} />
    </ReactFlowProvider>
  );
}
