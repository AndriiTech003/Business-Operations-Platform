import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDetailDto, WorkflowDto, WorkflowTemplateDto } from '@bop/contracts';
import { WORKFLOW_TEMPLATES } from '@bop/workflow-core';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  SkeletonRows,
  cn,
  toast,
} from '@bop/ui';
import { CalendarClock, CircleAlert, FilePlus2, Hand, Plus, Radio, Search, Webhook, Workflow, Zap } from 'lucide-react';
import { Page, PageHeader } from '../../components/PageHeader';
import { api, asList, errorMessage } from '../../lib/api';
import { relative } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useAuth } from '../../app/auth';

const TRIGGER_ICON = {
  record_event: Zap,
  record_condition: Search,
  schedule: CalendarClock,
  webhook: Webhook,
  manual: Hand,
} as const;

function triggerIcon(type: string | null) {
  return (
    type !== null && type in TRIGGER_ICON ? TRIGGER_ICON[type as keyof typeof TRIGGER_ICON] : Radio
  ) as typeof Zap;
}

export function NewWorkflowDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery({
    queryKey: keys.workflows.templates,
    queryFn: async () => asList<WorkflowTemplateDto>(await api.get('/v1/workflows/templates')),
    enabled: open,
    staleTime: 300_000,
  });
  const list = templates.data ?? (templates.isError ? WORKFLOW_TEMPLATES : []);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => {
      const tpl = list.find((t) => t.key === selected);
      return api.post<WorkflowDetailDto>('/v1/workflows', {
        name: name.trim() || tpl?.name || 'Untitled workflow',
        ...(selected ? { templateKey: selected } : {}),
      });
    },
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: keys.workflows.all });
      onOpenChange(false);
      void navigate({ to: '/workflows/$id', params: { id: wf.id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="template-gallery">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Start from a template or a blank canvas. You can change everything before publishing.
          </DialogDescription>
        </DialogHeader>
        {templates.isLoading ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Templates">
            <button
              type="button"
              role="radio"
              aria-checked={selected === null}
              onClick={() => setSelected(null)}
              data-testid="template-blank"
              className={cn(
                'flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed p-4 text-left hover:bg-muted/50',
                selected === null && 'border-solid border-primary ring-1 ring-primary',
              )}
            >
              <FilePlus2 className="size-5 text-muted-foreground" />
              <span className="text-sm font-semibold">Blank workflow</span>
              <span className="text-xs text-muted-foreground">Manual trigger, empty canvas.</span>
            </button>
            {list.map((t) => {
              const Icon = triggerIcon(t.definition.trigger.type);
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={selected === t.key}
                  data-testid={`template-${t.key}`}
                  data-template-name={t.name}
                  onClick={() => {
                    setSelected(t.key);
                    setName(t.name);
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left hover:bg-muted/50',
                    selected === t.key && 'border-primary ring-1 ring-primary',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="size-5 text-primary" />
                    <Badge variant="secondary">{t.definition.nodes.length} steps</Badge>
                  </div>
                  <span className="text-sm font-semibold">{t.name}</span>
                  <span className="line-clamp-3 text-xs text-muted-foreground">{t.description}</span>
                </button>
              );
            })}
          </div>
        )}
        <Field label="Name" htmlFor="wf-new-name">
          <Input
            id="wf-new-name"
            data-testid="field-name"
            value={name}
            placeholder="Untitled workflow"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="dialog-submit" loading={create.isPending} onClick={() => create.mutate()}>
            Create & open builder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: keys.workflows.list,
    queryFn: async () => asList<WorkflowDto>(await api.get('/v1/workflows')),
  });
  const workflows = query.data ?? [];
  return (
    <Page>
      <PageHeader
        icon={<Workflow />}
        title="Workflows"
        description="Automations that run on a durable engine: triggers → conditions → actions, waits and approvals"
        actions={
          <Button
            size="sm"
            onClick={() => setOpen(true)}
            disabled={!can('workflows:write')}
            data-testid="create-workflow"
          >
            <Plus /> New workflow
          </Button>
        }
      />
      {query.isLoading ? (
        <SkeletonRows rows={6} />
      ) : workflows.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="No workflows yet"
          description="Start from a template like “Overdue invoice follow-up”."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus /> New workflow
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="workflow-list">
          {workflows.map((w) => {
            const Icon = triggerIcon(w.triggerType);
            return (
              <Card
                key={w.id}
                className="transition-shadow hover:shadow-md"
                data-testid="workflow-card"
                data-name={w.name}
              >
                <Link to="/workflows/$id" params={{ id: w.id }} className="grid gap-3 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{w.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {w.triggerType?.replace('_', ' ') ?? 'no trigger'}
                        {w.triggerKey ? ` · ${w.triggerKey}` : ''}
                      </p>
                    </div>
                    <Badge variant={w.status === 'active' ? 'success' : w.status === 'paused' ? 'warning' : 'muted'}>
                      {w.status}
                    </Badge>
                  </div>
                  {w.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{w.description}</p> : null}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{w.activeVersion ? `v${w.activeVersion}` : 'unpublished'}</span>
                    <span>{w.stats?.runs ?? 0} runs</span>
                    {(w.stats?.running ?? 0) > 0 ? <span className="text-info">{w.stats?.running} running</span> : null}
                    {(w.stats?.failed ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-destructive">
                        <CircleAlert className="size-3" /> {w.stats?.failed} failed
                      </span>
                    ) : null}
                    <span className="ml-auto">
                      {w.stats?.lastRunAt
                        ? `last run ${relative(w.stats.lastRunAt)}`
                        : `updated ${relative(w.updatedAt)}`}
                    </span>
                  </div>
                </Link>
                <div className="flex border-t px-4 py-2">
                  <Link to="/runs" search={{ workflowId: w.id }} className="text-xs text-primary hover:underline">
                    View runs →
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <NewWorkflowDialog open={open} onOpenChange={setOpen} />
    </Page>
  );
}
