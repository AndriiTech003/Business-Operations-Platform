import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskDto } from '@bop/contracts';
import { Button, Card, EmptyState, SkeletonRows } from '@bop/ui';
import { ListTodo, Plus } from 'lucide-react';
import { api, asList } from '../../lib/api';
import { keys, type RecordEntity } from '../../lib/query-keys';
import { CreateTaskDialog, TaskRow } from '../../features/tasks/task-ui';

export function RecordTasks({ entity, id, title }: { entity: RecordEntity; id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: keys.recordTasks(entity, id),
    queryFn: async () => asList<TaskDto>(await api.get(`/v1/records/${entity}/${id}/tasks`)),
  });
  const tasks = query.data ?? [];
  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const doneTasks = tasks.filter((t) => t.status === 'done' || t.status === 'cancelled');
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {openTasks.length} open · {doneTasks.length} done
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="create-task">
          <Plus /> Add task
        </Button>
      </div>
      {query.isLoading ? (
        <SkeletonRows rows={3} />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={<ListTodo />}
          title="No tasks"
          description="Tasks created by people, workflows or the AI agent for this record show up here."
        />
      ) : (
        <Card>
          <ul>
            {[...openTasks, ...doneTasks].map((t) => (
              <TaskRow key={t.id} task={t} showRelated={false} />
            ))}
          </ul>
        </Card>
      )}
      <CreateTaskDialog open={open} onOpenChange={setOpen} related={{ type: entity, id, title }} />
    </div>
  );
}
