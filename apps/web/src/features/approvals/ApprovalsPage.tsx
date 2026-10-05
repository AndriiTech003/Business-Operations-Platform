import { useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDto } from '@bop/contracts';
import {
  AvatarStack,
  Badge,
  Button,
  Card,
  EmptyState,
  SkeletonRows,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  cn,
  toast,
} from '@bop/ui';
import { Bot, Check, Clock, ExternalLink, Inbox, ShieldAlert, Workflow, X } from 'lucide-react';
import { useAuth, useMe } from '../../app/auth';
import { api, asList, errorMessage } from '../../lib/api';
import { countdown, fmtDateTime, humanize, money, relative, toDate } from '../../lib/format';
import { useMemberMap } from '../../lib/data';
import { useNow } from '../../lib/hooks';
import { keys } from '../../lib/query-keys';
import { usePollInterval } from '../../lib/realtime';
import { recordHref } from '../../components/record-links';

const route = getRouteApi('/app/approvals');

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const KNOWN = new Set([
  'description',
  'workflow',
  'record',
  'amountCents',
  'currency',
  'email',
  'preview',
  'changes',
  'patch',
  'diff',
  'action',
  'tool',
  'risk',
  'reason',
  'workflowId',
  'runId',
  'stepRunId',
  'nodeId',
]);

function show(key: string, v: unknown): string {
  if (typeof v === 'number' && /Cents$/.test(key)) return money(v);
  if (v === null || v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function ActionPreview({ details }: { details: Record<string, unknown> }) {
  const email =
    obj(details['email']) ?? (obj(details['preview'])?.['subject'] !== undefined ? obj(details['preview']) : null);
  const changes = obj(details['changes']) ?? obj(details['patch']) ?? obj(details['diff']);
  const rest = Object.entries(details).filter(([k]) => !KNOWN.has(k));
  return (
    <div className="grid gap-2">
      {email ? (
        <div className="overflow-hidden rounded-md border" data-testid="approval-email-preview">
          <div className="grid gap-0.5 border-b bg-muted/40 px-3 py-1.5 text-xs">
            {email['to'] !== undefined ? (
              <span>To: {Array.isArray(email['to']) ? (email['to'] as string[]).join(', ') : String(email['to'])}</span>
            ) : null}
            {str(email['subject']) ? <span className="font-medium">Subject: {str(email['subject'])}</span> : null}
          </div>
          {str(email['html']) ? (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={str(email['html']) ?? ''}
              className="h-48 w-full bg-white"
            />
          ) : str(email['body']) ? (
            <p className="whitespace-pre-wrap p-3 text-sm">{str(email['body'])}</p>
          ) : null}
        </div>
      ) : null}
      {changes ? (
        <table className="w-full overflow-hidden rounded-md border text-xs" data-testid="approval-changes">
          <tbody>
            {Object.entries(changes).map(([k, v]) => {
              const c = obj(v);
              const hasFromTo = c !== null && ('from' in c || 'to' in c);
              return (
                <tr key={k} className="border-b last:border-0">
                  <td className="w-40 px-2 py-1 font-medium">{humanize(k)}</td>
                  {hasFromTo ? (
                    <td className="px-2 py-1">
                      <span className="text-muted-foreground line-through">{show(k, c?.['from'])}</span> →{' '}
                      <span>{show(k, c?.['to'])}</span>
                    </td>
                  ) : (
                    <td className="px-2 py-1">{typeof v === 'string' ? v : JSON.stringify(v)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {rest.length > 0 ? (
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs">
          {rest.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{humanize(k)}</dt>
              <dd className="break-words">
                {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (
                  String(v)
                ) : (
                  <code className="text-[11px]">{JSON.stringify(v)}</code>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalDto }) {
  const me = useMe();
  const { can } = useAuth();
  const qc = useQueryClient();
  const now = useNow(1000);
  const members = useMemberMap();
  const [comment, setComment] = useState('');
  const details = approval.details ?? {};
  const record = obj(details['record']);
  const workflow = obj(details['workflow']);
  const amount = typeof details['amountCents'] === 'number' ? (details['amountCents'] as number) : null;
  const expires = toDate(approval.expiresAt);
  const urgent = expires !== null && expires.getTime() - now.getTime() < 6 * 3_600_000;
  const pending = approval.status === 'pending';
  const assignedToMe = approval.assigneeIds.length === 0 || approval.assigneeIds.includes(me.user.id);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api.post<ApprovalDto>(`/v1/approvals/${approval.id}/decide`, { decision, comment: comment.trim() || undefined }),
    onMutate: async (decision) => {
      await qc.cancelQueries({ queryKey: keys.approvals.all });
      const snapshots = qc.getQueriesData<ApprovalDto[]>({ queryKey: ['approvals', 'list'] });
      for (const [key, data] of snapshots) {
        if (Array.isArray(data))
          qc.setQueryData(
            key,
            data.map((a) =>
              a.id === approval.id ? { ...a, status: decision === 'approve' ? 'approved' : 'rejected' } : a,
            ),
          );
      }
      qc.setQueryData<{ count: number }>(keys.approvals.count, (c) => (c ? { count: Math.max(0, c.count - 1) } : c));
      return { snapshots };
    },
    onSuccess: (_a, decision) =>
      toast.success(decision === 'approve' ? `Approved “${approval.title}”` : `Rejected “${approval.title}”`),
    onError: (e, _d, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
      toast.error(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.approvals.all }),
  });
  const runId = str(approval.sourceRef['runId']);
  return (
    <Card
      className={cn('grid gap-3 p-4', !pending && 'opacity-80')}
      data-testid="approval-card"
      data-title={approval.title}
      data-status={approval.status}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            approval.source === 'agent' ? 'bg-violet-100 text-violet-700' : 'bg-primary/10 text-primary',
          )}
        >
          {approval.source === 'agent' ? <Bot className="size-5" /> : <Workflow className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">{approval.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={approval.source === 'agent' ? 'info' : 'default'} data-testid="approval-source">
              {approval.source === 'agent' ? 'AI agent' : 'Workflow'}
            </Badge>
            {str(workflow?.['name']) ? <span>{str(workflow?.['name'])}</span> : null}
            <span>requested {relative(approval.createdAt)}</span>
          </div>
        </div>
        {pending && expires !== null ? (
          <Tooltip content={`Deadline ${fmtDateTime(expires)}`}>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs tabular-nums',
                urgent ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
              )}
              data-testid="approval-deadline"
            >
              <Clock className="size-3" /> {expires.getTime() < now.getTime() ? 'expired' : countdown(expires, now)}
            </span>
          </Tooltip>
        ) : null}
        {!pending ? (
          <Badge
            variant={
              approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'destructive' : 'muted'
            }
          >
            {approval.status}
          </Badge>
        ) : null}
      </div>
      {str(details['description']) ? <p className="text-sm">{str(details['description'])}</p> : null}
      {record || amount !== null ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
          {record && str(record['id']) && str(record['type']) ? (
            <Link
              {...recordHref(String(record['type']), String(record['id']))}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              {str(record['title']) ?? humanize(String(record['type']))} <ExternalLink className="size-3" />
            </Link>
          ) : null}
          {amount !== null ? (
            <span className="font-semibold tabular-nums">{money(amount, str(details['currency']) ?? 'USD')}</span>
          ) : null}
          {runId ? (
            <Link
              to="/runs/$id"
              params={{ id: runId }}
              className="ml-auto text-xs text-muted-foreground hover:underline"
            >
              view run →
            </Link>
          ) : null}
        </div>
      ) : null}
      {approval.source === 'agent' ? (
        <p className="flex items-center gap-1 text-xs text-[oklch(0.5_0.12_70)]">
          <ShieldAlert className="size-3.5" /> Proposed by the AI agent — review the action before approving.
        </p>
      ) : null}
      <ActionPreview details={details} />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Approvers:</span>
        {approval.assignees.length > 0 ? (
          <AvatarStack people={approval.assignees} size="xs" />
        ) : (
          <span>anyone with approval rights</span>
        )}
      </div>
      {pending ? (
        <div className="grid gap-2 border-t pt-3">
          <Textarea
            className="min-h-14"
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="approval-comment"
          />
          <div className="flex items-center gap-2">
            {!assignedToMe ? <span className="text-xs text-muted-foreground">Not assigned to you</span> : null}
            <Button
              className="ml-auto"
              variant="outline"
              size="sm"
              disabled={!can('approvals:decide') || decide.isPending}
              onClick={() => decide.mutate('reject')}
              data-testid="approval-reject"
            >
              <X /> Reject
            </Button>
            <Button
              variant="success"
              size="sm"
              disabled={!can('approvals:decide') || decide.isPending}
              onClick={() => decide.mutate('approve')}
              data-testid="approval-approve"
            >
              <Check /> Approve
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t pt-2 text-xs text-muted-foreground">
          {approval.status} {approval.decidedBy ? `by ${members.get(approval.decidedBy)?.name ?? 'someone'}` : ''}{' '}
          {approval.decidedAt ? relative(approval.decidedAt) : ''}
          {approval.comment ? ` — “${approval.comment}”` : ''}
        </p>
      )}
    </Card>
  );
}

export function ApprovalsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const tab = search.tab ?? 'mine';
  const interval = usePollInterval(5000);
  const params = tab === 'mine' ? { status: 'pending', mine: '1' } : tab === 'pending' ? { status: 'pending' } : {};
  const query = useQuery({
    queryKey: keys.approvals.list({ tab }),
    queryFn: async () => asList<ApprovalDto>(await api.get('/v1/approvals', { query: params })),
    refetchInterval: interval === false ? 60_000 : interval,
  });
  const items = (query.data ?? []).filter((a) => (tab === 'decided' ? a.status !== 'pending' : true));
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Inbox className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Approvals</h1>
            <p className="text-sm text-muted-foreground">Decisions requested by workflows and the AI agent</p>
          </div>
        </div>
      </div>
      <Tabs
        value={tab}
        onValueChange={(t) =>
          void navigate({ to: '/approvals', search: { tab: t as 'mine' | 'pending' | 'decided' }, replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="mine" data-testid="approvals-tab-mine">
            Waiting for me
          </TabsTrigger>
          <TabsTrigger value="pending" data-testid="approvals-tab-pending">
            All pending
          </TabsTrigger>
          <TabsTrigger value="decided" data-testid="approvals-tab-decided">
            Decided
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {query.isLoading ? (
        <SkeletonRows rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={tab === 'decided' ? 'No decisions yet' : 'Nothing to approve'}
          description="When a workflow reaches an approval step or the AI agent asks for permission, it shows up here in real time."
        />
      ) : (
        <div className="grid max-w-4xl gap-3" data-testid="approvals-list">
          {items.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
    </div>
  );
}
