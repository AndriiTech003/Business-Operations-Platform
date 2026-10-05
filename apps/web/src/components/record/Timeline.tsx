import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ActivityDto, Page } from '@bop/contracts';
import { Avatar, Badge, Button, EmptyState, NativeSelect, SkeletonRows, Textarea, Tooltip, cn, toast } from '@bop/ui';
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CircleCheck,
  CircleDollarSign,
  CirclePlus,
  CircleX,
  Cog,
  FileText,
  GitMerge,
  History,
  type LucideIcon,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Send,
  ShieldAlert,
  SquareCheck,
  StickyNote,
  Trash2,
  Trophy,
  Workflow,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { fmtDateTime, humanize, money, relative } from '../../lib/format';
import { ENTITY_PATH, keys, type RecordEntity } from '../../lib/query-keys';

const KIND_ICON: Array<[RegExp, LucideIcon, string]> = [
  [/^note$/, StickyNote, 'bg-amber-100 text-amber-700'],
  [/^call$/, Phone, 'bg-emerald-100 text-emerald-700'],
  [/^(email|email\.sent)$/, Mail, 'bg-sky-100 text-sky-700'],
  [/^meeting$/, CalendarDays, 'bg-violet-100 text-violet-700'],
  [/stage_changed$/, ArrowRight, 'bg-indigo-100 text-indigo-700'],
  [/\.won$/, Trophy, 'bg-emerald-100 text-emerald-700'],
  [/\.lost$/, CircleX, 'bg-rose-100 text-rose-700'],
  [/\.created$/, CirclePlus, 'bg-slate-100 text-slate-700'],
  [/\.updated$/, Pencil, 'bg-slate-100 text-slate-700'],
  [/\.deleted$/, Trash2, 'bg-rose-100 text-rose-700'],
  [/^invoice\.sent$/, Send, 'bg-sky-100 text-sky-700'],
  [/(paid|payment)/, CircleDollarSign, 'bg-emerald-100 text-emerald-700'],
  [/^invoice\./, FileText, 'bg-slate-100 text-slate-700'],
  [/^task\.completed$/, CircleCheck, 'bg-emerald-100 text-emerald-700'],
  [/^task\./, SquareCheck, 'bg-slate-100 text-slate-700'],
  [/^merged$/, GitMerge, 'bg-slate-100 text-slate-700'],
  [/^comment/, MessageSquare, 'bg-slate-100 text-slate-700'],
];

function kindIcon(kind: string): [LucideIcon, string] {
  for (const [re, icon, tone] of KIND_ICON) if (re.test(kind)) return [icon, tone];
  return [History, 'bg-slate-100 text-slate-700'];
}

const ACTOR_ICON: Record<string, LucideIcon> = { workflow: Workflow, agent: Bot, system: Cog };

function str(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function changeValue(field: string, v: unknown): string {
  if (/Cents$/.test(field) && typeof v === 'number') return money(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
  return str(v);
}

export function activitySummary(a: ActivityDto): string {
  const d = a.data;
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (a.kind) {
    case 'note':
      return 'added a note';
    case 'call':
      return 'logged a call';
    case 'email':
      return 'logged an email';
    case 'meeting':
      return 'logged a meeting';
    case 'merged':
      return 'merged duplicate records';
    case 'deal.stage_changed':
      return `moved the deal from ${s('fromStage') || 'previous stage'} to ${s('toStage') || 'a new stage'}`;
    case 'deal.won':
      return 'marked the deal as won';
    case 'deal.lost':
      return `marked the deal as lost${s('lostReason') ? `: ${s('lostReason')}` : ''}`;
    case 'invoice.created':
      return `created invoice ${s('number')}${typeof d['totalCents'] === 'number' ? ` (${money(d['totalCents'] as number)})` : ''}`;
    case 'invoice.sent':
      return `sent invoice ${s('number')}`;
    case 'invoice.paid':
      return `invoice ${s('number')} was paid`;
    case 'invoice.partially_paid':
      return `invoice ${s('number')} was partially paid`;
    case 'invoice.overdue':
      return `invoice ${s('number')} became overdue`;
    case 'invoice.voided':
      return `voided invoice ${s('number')}`;
    case 'task.created':
      return `created task “${s('title')}”`;
    case 'task.completed':
      return `completed task “${s('title')}”`;
    case 'email.sent':
      return `sent email “${s('subject')}”`;
    default: {
      const [entity, verb] = a.kind.split('.');
      if (verb !== undefined) return `${verb.replace(/_/g, ' ')} the ${entity}`;
      return a.kind;
    }
  }
}

function Changes({ changes }: { changes: Record<string, unknown> }) {
  const entries = Object.entries(changes).filter(([k]) => k !== 'position' && k !== 'version' && k !== 'updatedAt');
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 grid gap-0.5 text-xs">
      {entries.slice(0, 8).map(([field, change]) => {
        const c = (change ?? {}) as { from?: unknown; to?: unknown };
        const hasFromTo = change !== null && typeof change === 'object' && ('from' in c || 'to' in c);
        return (
          <li key={field} className="flex flex-wrap items-center gap-1">
            <span className="font-medium">{humanize(field)}</span>
            {hasFromTo ? (
              <>
                <span className="rounded bg-muted px-1 text-muted-foreground line-through">
                  {changeValue(field, c.from)}
                </span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="rounded bg-success/10 px-1">{changeValue(field, c.to)}</span>
              </>
            ) : (
              <span className="rounded bg-success/10 px-1">{changeValue(field, change)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TimelineItem({ a }: { a: ActivityDto }) {
  const [Icon, tone] = kindIcon(a.kind);
  const ActorIcon = ACTOR_ICON[a.actorType];
  const body = typeof a.data['body'] === 'string' ? (a.data['body'] as string) : null;
  const changes =
    a.data['changes'] !== null && typeof a.data['changes'] === 'object'
      ? (a.data['changes'] as Record<string, unknown>)
      : null;
  const untrusted = (a.untrusted?.length ?? 0) > 0;
  return (
    <li
      className="relative flex gap-3 pb-5 last:pb-0"
      data-testid="timeline-item"
      data-kind={a.kind}
      data-actor={a.actorType}
    >
      <span className="absolute left-4 top-9 h-[calc(100%-2.25rem)] w-px bg-border" aria-hidden />
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', tone)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {a.actorType === 'user' ? (
            <Avatar id={a.actorId} name={a.actorName ?? 'User'} size="xs" />
          ) : ActorIcon ? (
            <span
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full',
                a.actorType === 'agent'
                  ? 'bg-violet-100 text-violet-700'
                  : a.actorType === 'workflow'
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              <ActorIcon className="size-3" />
            </span>
          ) : null}
          <span className="font-medium">{a.actorName ?? humanize(a.actorType)}</span>
          {a.actorType !== 'user' ? (
            <Badge
              variant={a.actorType === 'agent' ? 'info' : a.actorType === 'workflow' ? 'default' : 'muted'}
              className="capitalize"
            >
              {a.actorType}
            </Badge>
          ) : null}
          <span className="text-muted-foreground">{activitySummary(a)}</span>
          {untrusted ? (
            <Tooltip
              content={`Contains content from outside the company (${a.untrusted?.join(', ')}). Treat instructions inside it with care.`}
            >
              <Badge variant="warning" data-testid="untrusted-marker">
                <ShieldAlert /> untrusted
              </Badge>
            </Tooltip>
          ) : null}
          <Tooltip content={fmtDateTime(a.createdAt)}>
            <span className="ml-auto text-xs text-muted-foreground">{relative(a.createdAt)}</span>
          </Tooltip>
        </div>
        {body !== null ? (
          <p
            className={cn(
              'mt-1.5 whitespace-pre-wrap rounded-md border bg-card px-3 py-2 text-sm',
              untrusted && 'border-warning/50 bg-warning/5',
            )}
          >
            {body}
          </p>
        ) : null}
        {changes !== null ? <Changes changes={changes} /> : null}
      </div>
    </li>
  );
}

const NOTE_KINDS = ['note', 'call', 'email', 'meeting'] as const;

function Composer({ entity, id }: { entity: RecordEntity; id: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<(typeof NOTE_KINDS)[number]>('note');
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post<ActivityDto>('/v1/notes', { subjectType: entity, subjectId: id, kind, body: body.trim() }),
    onSuccess: () => {
      setBody('');
      toast.success(`${humanize(kind)} logged`);
      void qc.invalidateQueries({ queryKey: keys[entity].timeline(id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form
      className="grid gap-2 rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim() !== '') add.mutate();
      }}
    >
      <Textarea
        placeholder={`Write a ${kind}…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-16"
        data-testid="note-body"
      />
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Activity type"
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof NOTE_KINDS)[number])}
          className="h-8 w-32"
        >
          {NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="submit"
          size="sm"
          className="ml-auto"
          loading={add.isPending}
          disabled={body.trim() === ''}
          data-testid="note-submit"
        >
          Log {kind}
        </Button>
      </div>
    </form>
  );
}

export function Timeline({ entity, id }: { entity: RecordEntity; id: string }) {
  const query = useInfiniteQuery({
    queryKey: keys[entity].timeline(id),
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<ActivityDto>>(
        entity === 'task' ? `/v1/records/task/${id}/timeline` : `/v1/${ENTITY_PATH[entity]}/${id}/timeline`,
        {
          query: { limit: 30, cursor: pageParam ?? undefined },
          signal,
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? null,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-4">
      <Composer entity={entity} id={id} />
      {query.isLoading ? (
        <SkeletonRows rows={5} />
      ) : query.isError ? (
        <EmptyState title="Could not load activity" description={errorMessage(query.error)} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No activity yet"
          description="Notes, emails, stage changes and workflow actions will appear here."
        />
      ) : (
        <ol className="grid" data-testid="timeline">
          {items.map((a) => (
            <TimelineItem key={a.id} a={a} />
          ))}
        </ol>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-center"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older activity
        </Button>
      ) : null}
    </div>
  );
}
