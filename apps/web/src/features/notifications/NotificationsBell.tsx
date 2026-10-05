import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { NotificationDto } from '@bop/contracts';
import { Button, EmptyState, Popover, PopoverContent, PopoverTrigger, Skeleton, cn, toast } from '@bop/ui';
import {
  AtSign,
  Bell,
  BellOff,
  CheckCheck,
  CircleAlert,
  ClipboardCheck,
  Clock,
  Inbox,
  type LucideIcon,
  Workflow,
} from 'lucide-react';
import { API_URL, api, asList, getAccessToken } from '../../lib/api';
import { relative } from '../../lib/format';
import { useLatest } from '../../lib/hooks';
import { keys } from '../../lib/query-keys';
import { channels, useChannel, useRealtimeStatus } from '../../lib/realtime';
import { useMe } from '../../app/auth';

interface NotificationsData {
  items: NotificationDto[];
  unread: number;
}

const ICONS: Record<string, LucideIcon> = {
  mention: AtSign,
  'task.assigned': ClipboardCheck,
  'task.reminder': Clock,
  'workflow.notify': Workflow,
  'workflow.failed': CircleAlert,
  'approval.requested': Inbox,
};

export function notificationText(n: NotificationDto): string {
  const p = n.payload;
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (n.kind) {
    case 'mention':
      return `You were mentioned: ${str('excerpt') || 'in a comment'}`;
    case 'task.assigned':
      return `Task assigned to you: ${str('title')}`;
    case 'task.reminder':
      return `Task due: ${str('title')}`;
    case 'workflow.notify':
      return str('message') || 'Workflow notification';
    case 'workflow.failed':
      return `Workflow "${str('workflow')}" failed${str('nodeId') ? ` at ${str('nodeId')}` : ''}: ${str('message')}`;
    case 'approval.requested':
      return `Approval requested: ${str('title')}`;
    default:
      return str('message') || str('title') || n.kind;
  }
}

function normalize(value: unknown): NotificationsData {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    const v = value as { items: NotificationDto[]; unread?: number };
    return { items: v.items, unread: v.unread ?? v.items.filter((i) => i.readAt === null).length };
  }
  const items = asList<NotificationDto>(value);
  return { items, unread: items.filter((i) => i.readAt === null).length };
}

function useTarget() {
  const navigate = useNavigate();
  return (n: NotificationDto) => {
    const p = n.payload;
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
    if (n.kind === 'approval.requested') return void navigate({ to: '/approvals' });
    if (n.kind.startsWith('task.')) return void navigate({ to: '/tasks' });
    if (n.kind === 'workflow.failed' && s('runId'))
      return void navigate({ to: '/runs/$id', params: { id: s('runId') as string } });
    const type = s('subjectType') ?? s('entity');
    const id = s('subjectId') ?? s('recordId');
    if (type !== null && id !== null) {
      if (type === 'company') return void navigate({ to: '/companies/$id', params: { id } });
      if (type === 'contact') return void navigate({ to: '/contacts/$id', params: { id } });
      if (type === 'deal') return void navigate({ to: '/deals/$id', params: { id } });
      if (type === 'invoice') return void navigate({ to: '/invoices/$id', params: { id } });
    }
    if (s('runId')) return void navigate({ to: '/runs/$id', params: { id: s('runId') as string } });
  };
}

export function NotificationsBell() {
  const me = useMe();
  const qc = useQueryClient();
  const status = useRealtimeStatus();
  const open = useTarget();
  const { data, isLoading } = useQuery({
    queryKey: keys.notifications,
    queryFn: async () => normalize(await api.get('/v1/notifications')),
    refetchInterval: status === 'open' ? 120_000 : 30_000,
  });

  const push = (n: NotificationDto) => {
    qc.setQueryData<NotificationsData>(keys.notifications, (old) => {
      const items = old?.items ?? [];
      if (items.some((i) => i.id === n.id)) return old;
      return { items: [n, ...items].slice(0, 100), unread: (old?.unread ?? 0) + (n.readAt === null ? 1 : 0) };
    });
    toast(notificationText(n), { action: { label: 'Open', onClick: () => open(n) } });
  };

  const pushRef = useLatest(push);

  useChannel(channels.user(me.user.id), {
    onMessage: (d) => {
      const n = (d['notification'] ?? null) as NotificationDto | null;
      if (d['type'] === 'notification' && n !== null && typeof n.id === 'string') push(n);
    },
  });

  useEffect(() => {
    if (status !== 'unavailable' || typeof EventSource === 'undefined') return undefined;
    const token = getAccessToken();
    if (token === null) return undefined;
    const source = new EventSource(`${API_URL}/v1/notifications/stream?access_token=${encodeURIComponent(token)}`, {
      withCredentials: true,
    });
    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        const body = JSON.parse(ev.data) as { notification?: NotificationDto } & Partial<NotificationDto>;
        const n = body.notification ?? (typeof body.id === 'string' ? (body as NotificationDto) : null);
        if (n !== null) pushRef.current(n);
      } catch {
        return;
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [status, pushRef]);

  const markRead = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) => api.post('/v1/notifications/read', body),
    onMutate: (body) => {
      const now = new Date().toISOString();
      qc.setQueryData<NotificationsData>(keys.notifications, (old) => {
        if (old === undefined) return old;
        const ids = 'ids' in body ? new Set(body.ids) : null;
        const items = old.items.map((i) =>
          i.readAt === null && (ids === null || ids.has(i.id)) ? { ...i, readAt: now } : i,
        );
        return { items, unread: items.filter((i) => i.readAt === null).length };
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });

  const unread = data?.unread ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
          data-testid="notifications-bell"
        >
          <Bell />
          {unread > 0 ? (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white"
              data-testid="notifications-unread"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          <Button variant="ghost" size="xs" disabled={unread === 0} onClick={() => markRead.mutate({ all: true })}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {isLoading ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <EmptyState
              className="m-3 border-0"
              icon={<BellOff />}
              title="You're all caught up"
              description="Mentions, assignments and workflow alerts show up here."
            />
          ) : (
            <ul>
              {data?.items.map((n) => {
                const Icon = ICONS[n.kind] ?? Bell;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      data-testid="notification-item"
                      className={cn(
                        'flex w-full cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 text-left text-sm hover:bg-muted/60',
                        n.readAt === null && 'bg-accent/40',
                      )}
                      onClick={() => {
                        if (n.readAt === null) markRead.mutate({ ids: [n.id] });
                        open(n);
                      }}
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2">{notificationText(n)}</span>
                        <span className="text-xs text-muted-foreground">{relative(n.createdAt)}</span>
                      </span>
                      {n.readAt === null ? (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
