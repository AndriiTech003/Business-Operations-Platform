import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { RunDto, WorkflowDetailDto, WorkflowDto } from '@bop/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  cn,
  toast,
} from '@bop/ui';
import { Play, Workflow } from 'lucide-react';
import { api, asList, errorMessage } from '../../lib/api';
import { fromDateInput } from '../../lib/format';
import { keys, type RecordEntity } from '../../lib/query-keys';

type ManualInput = { key: string; label: string; type: 'string' | 'number' | 'bool' | 'date'; required?: boolean };

export function RunWorkflowDialog({
  entity,
  id,
  open,
  onOpenChange,
}: {
  entity: RecordEntity;
  id: string;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const list = useQuery({
    queryKey: keys.workflows.list,
    queryFn: async () => asList<WorkflowDto>(await api.get('/v1/workflows')),
    enabled: open,
  });
  const manual = useMemo(
    () => (list.data ?? []).filter((w) => w.status === 'active' && w.triggerType === 'manual'),
    [list.data],
  );
  const details = useQuery({
    queryKey: ['workflows', 'manual-details', manual.map((m) => m.id).join(',')],
    queryFn: () => Promise.all(manual.map((m) => api.get<WorkflowDetailDto>(`/v1/workflows/${m.id}`))),
    enabled: open && manual.length > 0,
  });
  const candidates = useMemo(
    () =>
      (details.data ?? []).filter((d) => {
        const trigger = d.active?.definition.trigger;
        return trigger?.type === 'manual' && (trigger.entity === undefined || trigger.entity === entity);
      }),
    [details.data, entity],
  );
  const chosen = candidates.find((c) => c.id === selected) ?? null;
  const trigger = chosen?.active?.definition.trigger;
  const inputs: ManualInput[] = trigger?.type === 'manual' ? (trigger.inputs ?? []) : [];

  const run = useMutation({
    mutationFn: () => api.post<RunDto>(`/v1/workflows/${chosen?.id}/runs`, { recordId: id, input: values }),
    onSuccess: (r) => {
      toast.success(`Started “${chosen?.name}”`, {
        action: { label: 'View run', onClick: () => void navigate({ to: '/runs/$id', params: { id: r.id } }) },
      });
      onOpenChange(false);
      setSelected(null);
      setValues({});
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const missing = inputs.some(
    (i) => i.required && (values[i.key] === undefined || values[i.key] === '' || values[i.key] === null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="run-workflow-dialog">
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>Active workflows with a manual trigger for this {entity}.</DialogDescription>
        </DialogHeader>
        {list.isLoading || details.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : candidates.length === 0 ? (
          <EmptyState
            icon={<Workflow />}
            title="No manual workflows"
            description={`Create a workflow with a “Manual” trigger for ${entity} records and publish it.`}
          />
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2" role="radiogroup">
              {candidates.map((c) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={c.id === selected}
                  key={c.id}
                  onClick={() => {
                    setSelected(c.id);
                    setValues({});
                  }}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50',
                    c.id === selected && 'border-primary ring-1 ring-primary',
                  )}
                >
                  <Workflow className="mt-0.5 size-4 text-primary" />
                  <span>
                    <span className="block text-sm font-medium">{c.name}</span>
                    {c.description ? (
                      <span className="block text-xs text-muted-foreground">{c.description}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            {chosen !== null && inputs.length > 0 ? (
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium text-muted-foreground">Inputs</p>
                {inputs.map((i) => (
                  <Field key={i.key} label={i.label} required={i.required} htmlFor={`input-${i.key}`}>
                    {i.type === 'bool' ? (
                      <Switch
                        id={`input-${i.key}`}
                        checked={values[i.key] === true}
                        onCheckedChange={(v) => setValues({ ...values, [i.key]: v })}
                      />
                    ) : (
                      <Input
                        id={`input-${i.key}`}
                        data-testid={`field-${i.key}`}
                        type={i.type === 'number' ? 'number' : i.type === 'date' ? 'date' : 'text'}
                        onChange={(e) =>
                          setValues({
                            ...values,
                            [i.key]:
                              i.type === 'number'
                                ? e.target.value === ''
                                  ? null
                                  : Number(e.target.value)
                                : i.type === 'date'
                                  ? fromDateInput(e.target.value)
                                  : e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="dialog-submit"
            disabled={chosen === null || missing}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            <Play /> Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
