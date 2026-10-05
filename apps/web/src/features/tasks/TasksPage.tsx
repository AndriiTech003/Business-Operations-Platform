import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TASK_STATUSES, type TaskDto } from '@bop/contracts';
import { Badge, Button, Card, EmptyState, Segmented, SkeletonRows, toast } from '@bop/ui';
import { CircleCheck, ListTodo, Plus, PartyPopper } from 'lucide-react';
import { isToday, isBefore, startOfDay } from 'date-fns';
import { DataTable, type ColumnSpec } from '../../components/data-table/DataTable';
import { Page, PageHeader } from '../../components/PageHeader';
import { RelationValue, UserName } from '../../components/FieldValue';
import { api, asList, errorMessage } from '../../lib/api';
import { toDate } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useRecordList } from '../../lib/records';
import { usePollInterval } from '../../lib/realtime';
import { useAuth } from '../../app/auth';
import type { tasksSearch } from '../../app/search';
import type { z } from 'zod';
import { CreateTaskDialog, PRIORITY, TaskRow, invalidateTasks } from './task-ui';

const route = getRouteApi('/app/tasks');
type TasksSearch = z.infer<typeof tasksSearch>;

const COLUMNS: ColumnSpec<TaskDto>[] = [
  {
    key: 'title',
    label: 'Title',
    type: 'text',
    editable: true,
    width: 260,
    render: (r) => (
      <span className={r.status === 'done' ? 'text-muted-foreground line-through' : 'font-medium'}>{r.title}</span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: TASK_STATUSES,
    editable: true,
    width: 120,
    render: (r) => (
      <Badge variant={r.status === 'done' ? 'success' : r.status === 'in_progress' ? 'info' : 'secondary'}>
        {r.status.replace('_', ' ')}
      </Badge>
    ),
  },
  {
    key: 'priority',
    label: 'Priority',
    type: 'select',
    options: ['1', '2', '3', '4'],
    optionLabels: { '1': 'Low', '2': 'Normal', '3': 'High', '4': 'Urgent' },
    width: 110,
    render: (r) => <Badge variant={PRIORITY[r.priority]?.variant}>{PRIORITY[r.priority]?.label}</Badge>,
  },
  { key: 'dueAt', label: 'Due', type: 'date', editable: true, width: 130 },
  {
    key: 'assigneeId',
    label: 'Assignee',
    type: 'user',
    editable: true,
    width: 160,
    render: (r) => <UserName id={r.assigneeId} name={r.assignee?.name} />,
  },
  {
    key: 'relatedId',
    label: 'Related to',
    type: 'text',
    sortable: false,
    filterable: false,
    width: 200,
    render: (r) =>
      r.related ? (
        <RelationValue entity={r.related.type} id={r.related.id} label={r.related.title} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'createdByType',
    label: 'Created by',
    type: 'select',
    options: ['user', 'workflow', 'agent', 'system'],
    width: 120,
    render: (r) => <Badge variant="muted">{r.createdByType}</Badge>,
  },
  { key: 'createdAt', label: 'Created', type: 'date', width: 120 },
];
const DEFAULT_COLUMNS = ['title', 'status', 'priority', 'dueAt', 'assigneeId', 'relatedId', 'createdByType'];

function useBulkComplete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post('/v1/tasks/bulk-complete', { ids }),
    onSuccess: (_r, ids) => toast.success(`Completed ${ids.length} task${ids.length === 1 ? '' : 's'}`),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => invalidateTasks(qc),
  });
}

function bucket(t: TaskDto): 'overdue' | 'today' | 'upcoming' | 'nodate' {
  const due = toDate(t.dueAt);
  if (due === null) return 'nodate';
  if (isToday(due)) return 'today';
  if (isBefore(due, startOfDay(new Date()))) return 'overdue';
  return 'upcoming';
}

const BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'nodate', label: 'No due date' },
] as const;

function MyTasks({ onCreate }: { onCreate(): void }) {
  const interval = usePollInterval(30_000);
  const query = useQuery({
    queryKey: keys.task.my,
    queryFn: async () => asList<TaskDto>(await api.get('/v1/tasks/my', { query: { limit: 200 } })),
    refetchInterval: interval === false ? 60_000 : interval,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useBulkComplete();
  const tasks = useMemo(() => query.data ?? [], [query.data]);
  const groups = useMemo(() => {
    const g: Record<string, TaskDto[]> = { overdue: [], today: [], upcoming: [], nodate: [] };
    for (const t of tasks) g[bucket(t)]?.push(t);
    return g;
  }, [tasks]);
  if (query.isLoading) return <SkeletonRows rows={8} />;
  if (tasks.length === 0)
    return (
      <EmptyState
        icon={<PartyPopper />}
        title="Inbox zero"
        description="No open tasks assigned to you. Workflows and teammates will add tasks here."
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus /> New task
          </Button>
        }
      />
    );
  return (
    <div className="grid gap-4">
      {selected.size > 0 ? (
        <div
          className="flex items-center gap-2 rounded-lg border bg-accent/50 px-3 py-1.5 text-sm"
          data-testid="bulk-bar"
        >
          <span className="font-medium">{selected.size} selected</span>
          <Button
            size="xs"
            variant="success"
            data-testid="bulk-complete"
            loading={bulk.isPending}
            onClick={() => {
              bulk.mutate([...selected]);
              setSelected(new Set());
            }}
          >
            <CircleCheck /> Complete
          </Button>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      {BUCKETS.map((b) =>
        (groups[b.key]?.length ?? 0) === 0 ? null : (
          <section key={b.key} aria-label={b.label}>
            <h2
              className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${b.key === 'overdue' ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {b.label} <span className="font-normal">· {groups[b.key]?.length}</span>
            </h2>
            <Card>
              <ul>
                {groups[b.key]?.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    selected={selected.has(t.id)}
                    onSelect={(v) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (v) n.add(t.id);
                        else n.delete(t.id);
                        return n;
                      })
                    }
                  />
                ))}
              </ul>
            </Card>
          </section>
        ),
      )}
    </div>
  );
}

function AllTasks({ search, setSearch }: { search: TasksSearch; setSearch(s: TasksSearch): void }) {
  const query = useRecordList<TaskDto>('task', search);
  const qc = useQueryClient();
  const bulk = useBulkComplete();
  const { can } = useAuth();
  const edit = useMutation({
    mutationFn: ({ row, key, value }: { row: TaskDto; key: string; value: unknown }) =>
      api.patch<TaskDto>(`/v1/tasks/${row.id}`, { [key]: key === 'priority' ? Number(value) : value }),
    onSuccess: () => invalidateTasks(qc),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <DataTable
      entity="tasks"
      columns={COLUMNS}
      defaultColumns={DEFAULT_COLUMNS}
      search={search}
      onSearchChange={(next) => setSearch({ ...next, scope: 'all' })}
      query={query}
      searchPlaceholder="Search tasks…"
      onCellEdit={can('records:write') ? (row, col, value) => edit.mutate({ row, key: col.key, value }) : undefined}
      bulkActions={(rows, clear) => (
        <Button
          size="xs"
          variant="success"
          data-testid="bulk-complete"
          onClick={() => {
            bulk.mutate(rows.map((r) => r.id));
            clear();
          }}
        >
          <CircleCheck /> Complete
        </Button>
      )}
    />
  );
}

export function TasksPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const scope = search.scope ?? 'mine';
  const setSearch = (next: TasksSearch) => void navigate({ to: '/tasks', search: next, replace: true });
  return (
    <Page>
      <PageHeader
        icon={<ListTodo />}
        title={scope === 'mine' ? 'My tasks' : 'All tasks'}
        description="Follow-ups from people, workflows and the AI agent"
        actions={
          <>
            <Segmented
              ariaLabel="Scope"
              value={scope}
              onChange={(v) => setSearch({ scope: v })}
              options={[
                { value: 'mine', label: 'Mine', testId: 'tasks-mine' },
                { value: 'all', label: 'All', testId: 'tasks-all' },
              ]}
            />
            <Button size="sm" onClick={() => setCreating(true)} data-testid="create-task">
              <Plus /> New task
            </Button>
          </>
        }
      />
      {scope === 'mine' ? (
        <MyTasks onCreate={() => setCreating(true)} />
      ) : (
        <AllTasks search={search} setSearch={setSearch} />
      )}
      <CreateTaskDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
