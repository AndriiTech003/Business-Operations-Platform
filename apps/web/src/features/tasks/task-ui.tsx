import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { taskCreateSchema, type SubjectType, type TaskDto } from '@bop/contracts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
  Tooltip,
  cn,
  toast,
} from '@bop/ui';
import { Bot, CalendarClock, Workflow } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { api, errorMessage } from '../../lib/api';
import { fmtDate, fromDateInput, toDate } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { UserPicker } from '../../components/pickers';
import { recordHref } from '../../components/record-links';
import { useMe } from '../../app/auth';

export const PRIORITY: Record<number, { label: string; variant: 'muted' | 'secondary' | 'warning' | 'destructive' }> = {
  1: { label: 'Low', variant: 'muted' },
  2: { label: 'Normal', variant: 'secondary' },
  3: { label: 'High', variant: 'warning' },
  4: { label: 'Urgent', variant: 'destructive' },
};

export function invalidateTasks(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: keys.task.all });
  void qc.invalidateQueries({ queryKey: ['record-tasks'] });
}

export function useToggleTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: TaskDto) =>
      api.patch<TaskDto>(`/v1/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' }),
    onMutate: async (t) => {
      const next = t.status === 'done' ? 'open' : 'done';
      const snapshots = qc.getQueriesData<unknown>({
        predicate: (q) => q.queryKey[0] === 'task' || q.queryKey[0] === 'record-tasks',
      });
      const mapItems = (items: TaskDto[]) =>
        items.map((x) => (x.id === t.id ? { ...x, status: next as TaskDto['status'] } : x));
      for (const [key, data] of snapshots) {
        if (Array.isArray(data)) qc.setQueryData(key, mapItems(data as TaskDto[]));
        else if (data !== null && typeof data === 'object' && 'pages' in data) {
          const d = data as { pages: Array<{ items: TaskDto[] }> };
          qc.setQueryData(key, { ...d, pages: d.pages.map((p) => ({ ...p, items: mapItems(p.items) })) });
        } else if (data !== null && typeof data === 'object' && 'items' in data) {
          const d = data as { items: TaskDto[] };
          qc.setQueryData(key, { ...d, items: mapItems(d.items) });
        }
      }
      return { snapshots };
    },
    onError: (e, _t, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
      toast.error(errorMessage(e));
    },
    onSettled: () => invalidateTasks(qc),
  });
}

export function TaskRow({
  task,
  showRelated = true,
  selected,
  onSelect,
}: {
  task: TaskDto;
  showRelated?: boolean;
  selected?: boolean;
  onSelect?(v: boolean): void;
}) {
  const toggle = useToggleTask();
  const due = toDate(task.dueAt);
  const overdue = due !== null && task.status !== 'done' && due.getTime() < Date.now();
  const done = task.status === 'done';
  return (
    <li
      className={cn('flex items-center gap-3 border-b px-3 py-2 last:border-0', selected && 'bg-accent/50')}
      data-testid="task-row"
      data-task-title={task.title}
    >
      {onSelect ? (
        <Checkbox aria-label="Select task" checked={selected === true} onCheckedChange={(v) => onSelect(v === true)} />
      ) : null}
      <button
        type="button"
        aria-label={done ? 'Reopen task' : 'Complete task'}
        data-testid="task-toggle"
        onClick={() => toggle.mutate(task)}
        className={cn(
          'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors',
          done ? 'border-success bg-success text-white' : 'border-input hover:border-success',
        )}
      >
        {done ? <span className="text-[10px]">✓</span> : null}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', done && 'text-muted-foreground line-through')}>{task.title}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {showRelated && task.related ? (
            <Link {...recordHref(task.related.type, task.related.id)} className="truncate text-primary hover:underline">
              {task.related.title}
            </Link>
          ) : null}
          {task.assignee ? <span>{task.assignee.name}</span> : null}
          {task.createdByType === 'workflow' ? (
            <Tooltip content="Created by a workflow">
              <Workflow className="size-3" />
            </Tooltip>
          ) : task.createdByType === 'agent' ? (
            <Tooltip content="Created by the AI agent">
              <Bot className="size-3" />
            </Tooltip>
          ) : null}
        </div>
      </div>
      <Badge variant={PRIORITY[task.priority]?.variant ?? 'secondary'}>
        {PRIORITY[task.priority]?.label ?? task.priority}
      </Badge>
      {due !== null ? (
        <span
          className={cn(
            'inline-flex w-28 items-center justify-end gap-1 text-xs',
            overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          <CalendarClock className="size-3" /> {fmtDate(due, 'MMM d')}
        </span>
      ) : (
        <span className="w-28" />
      )}
    </li>
  );
}

const formSchema = taskCreateSchema.extend({ dueDate: z.string().optional() });
type FormIn = z.input<typeof formSchema>;
type FormOut = z.output<typeof formSchema>;

export function CreateTaskDialog({
  open,
  onOpenChange,
  related,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  related?: { type: SubjectType; id: string; title?: string };
}) {
  const me = useMe();
  const qc = useQueryClient();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(formSchema),
    defaultValues: { title: '', description: '', priority: 2, assigneeId: me.user.id, dueDate: '' },
  });
  const [serverError, setServerError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (v: FormOut) =>
      api.post<TaskDto>('/v1/tasks', {
        title: v.title,
        description: v.description || null,
        priority: v.priority,
        assigneeId: v.assigneeId ?? null,
        dueAt: v.dueDate ? fromDateInput(v.dueDate) : null,
        relatedType: related?.type ?? null,
        relatedId: related?.id ?? null,
      }),
    onSuccess: (t) => {
      toast.success(`Task “${t.title}” created`);
      invalidateTasks(qc);
      form.reset();
      onOpenChange(false);
    },
    onError: (e) => setServerError(errorMessage(e)),
  });
  const errors = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task{related?.title ? ` for ${related.title}` : ''}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={form.handleSubmit((v) => create.mutate(v))}>
          <Field label="Title" htmlFor="task-title" error={errors.title?.message} required>
            <Input id="task-title" data-testid="field-title" autoFocus {...form.register('title')} />
          </Field>
          <Field label="Description" htmlFor="task-description">
            <Textarea id="task-description" data-testid="field-description" {...form.register('description')} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Assignee">
              <Controller
                control={form.control}
                name="assigneeId"
                render={({ field }) => (
                  <UserPicker value={field.value} onChange={field.onChange} testId="field-assigneeId" />
                )}
              />
            </Field>
            <Field label="Due date" htmlFor="task-due">
              <Input id="task-due" type="date" data-testid="field-dueAt" {...form.register('dueDate')} />
            </Field>
            <Field label="Priority" htmlFor="task-priority">
              <NativeSelect
                id="task-priority"
                data-testid="field-priority"
                {...form.register('priority', { valueAsNumber: true })}
              >
                {[1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY[p]?.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="dialog-submit" loading={create.isPending}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
