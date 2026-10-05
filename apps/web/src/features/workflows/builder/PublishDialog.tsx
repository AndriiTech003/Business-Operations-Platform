import { useQuery } from '@tanstack/react-query';
import type { WorkflowDetailDto, WorkflowEdge } from '@bop/contracts';
import { diffDefinitions, isEmptyDiff, type DefinitionDiff } from '@bop/workflow-core';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from '@bop/ui';
import { CircleAlert, Minus, Pencil, Plus, Rocket } from 'lucide-react';
import { api } from '../../../lib/api';
import { keys } from '../../../lib/query-keys';
import type { WorkflowDefinition } from '@bop/contracts';

function edgeText(e: WorkflowEdge) {
  return `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`;
}

export function PublishDialog({
  open,
  onOpenChange,
  workflow,
  definition,
  errors,
  onConfirm,
  publishing,
  ready,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  workflow: WorkflowDetailDto;
  definition: WorkflowDefinition;
  errors: number;
  onConfirm(): void;
  publishing: boolean;
  ready: boolean;
}) {
  const server = useQuery({
    queryKey: keys.workflows.diff(workflow.id),
    queryFn: () => api.get<DefinitionDiff>(`/v1/workflows/${workflow.id}/diff`),
    enabled: open && ready,
    staleTime: 0,
    retry: false,
  });
  const local = diffDefinitions(workflow.active?.definition ?? null, definition);
  const diff: DefinitionDiff = server.data ?? local;
  const empty = isEmptyDiff(diff) && workflow.active !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="publish-dialog">
        <DialogHeader>
          <DialogTitle>
            Publish {workflow.active ? `version ${(workflow.activeVersion ?? 0) + 1}` : 'first version'}
          </DialogTitle>
          <DialogDescription>
            {workflow.active
              ? `Changes compared to the active version ${workflow.active.version}. Running workflows stay on their version.`
              : 'This workflow has no published version yet.'}
          </DialogDescription>
        </DialogHeader>
        {errors > 0 ? (
          <Alert
            variant="destructive"
            icon={<CircleAlert />}
            title={`${errors} validation error${errors === 1 ? '' : 's'}`}
          >
            Fix the problems listed under the canvas before publishing.
          </Alert>
        ) : null}
        {server.isLoading || !ready ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="grid gap-3 text-sm" data-testid="publish-diff">
            {diff.triggerChanged ? (
              <p className="flex items-center gap-2">
                <Pencil className="size-4 text-info" /> Trigger changed
              </p>
            ) : null}
            {diff.nameChanged ? (
              <p className="flex items-center gap-2">
                <Pencil className="size-4 text-info" /> Renamed
              </p>
            ) : null}
            {diff.addedNodes.length > 0 ? (
              <div className="grid gap-1">
                <p className="text-xs font-medium text-muted-foreground">Added nodes</p>
                <div className="flex flex-wrap gap-1">
                  {diff.addedNodes.map((id) => (
                    <Badge key={id} variant="success" className="font-mono">
                      <Plus /> {id}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {diff.removedNodes.length > 0 ? (
              <div className="grid gap-1">
                <p className="text-xs font-medium text-muted-foreground">Removed nodes</p>
                <div className="flex flex-wrap gap-1">
                  {diff.removedNodes.map((id) => (
                    <Badge key={id} variant="destructive" className="font-mono">
                      <Minus /> {id}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {diff.changedNodes.length > 0 ? (
              <div className="grid gap-1">
                <p className="text-xs font-medium text-muted-foreground">Changed nodes</p>
                <ul className="grid gap-1">
                  {diff.changedNodes.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-1">
                      <Badge variant="info" className="font-mono">
                        <Pencil /> {c.id}
                      </Badge>
                      {c.fields.map((f) => (
                        <code key={f} className="rounded bg-muted px-1 text-[11px]">
                          {f}
                        </code>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {diff.addedEdges.length + diff.removedEdges.length > 0 ? (
              <div className="grid gap-1 text-xs">
                <p className="font-medium text-muted-foreground">Connections</p>
                {diff.addedEdges.map((e) => (
                  <p key={`a${edgeText(e)}`} className="text-success">
                    + {edgeText(e)}
                  </p>
                ))}
                {diff.removedEdges.map((e) => (
                  <p key={`r${edgeText(e)}`} className="text-destructive">
                    − {edgeText(e)}
                  </p>
                ))}
              </div>
            ) : null}
            {empty ? <p className="text-muted-foreground">No changes since the active version.</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="wf-publish-confirm"
            disabled={errors > 0 || empty || !ready}
            loading={publishing}
            onClick={onConfirm}
          >
            <Rocket /> Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
