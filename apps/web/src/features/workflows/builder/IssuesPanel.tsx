import { useState } from 'react';
import type { ValidationIssue } from '@bop/contracts';
import { Badge, cn } from '@bop/ui';
import { ChevronUp, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';

export function IssuesPanel({
  issues,
  onSelect,
}: {
  issues: ValidationIssue[];
  onSelect(issue: ValidationIssue): void;
}) {
  const [open, setOpen] = useState(true);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return (
    <section className="border-t bg-card" aria-label="Validation issues" data-testid="wf-issues">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs font-medium"
        aria-expanded={open}
      >
        {issues.length === 0 ? (
          <CircleCheck className="size-4 text-success" />
        ) : (
          <CircleAlert className="size-4 text-destructive" />
        )}
        {issues.length === 0 ? 'No problems — ready to publish' : 'Problems'}
        {errors > 0 ? (
          <Badge variant="destructive" data-testid="issues-errors">
            {errors} error{errors === 1 ? '' : 's'}
          </Badge>
        ) : null}
        {warnings > 0 ? (
          <Badge variant="warning">
            {warnings} warning{warnings === 1 ? '' : 's'}
          </Badge>
        ) : null}
        <ChevronUp className={cn('ml-auto size-4 transition-transform', !open && 'rotate-180')} />
      </button>
      {open && issues.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto border-t text-xs">
          {issues.map((i, n) => (
            <li key={n}>
              <button
                type="button"
                data-testid="issue-item"
                data-node-id={i.nodeId ?? ''}
                data-field={i.field ?? ''}
                onClick={() => onSelect(i)}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
              >
                {i.severity === 'error' ? (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                )}
                <span className="w-28 shrink-0 truncate font-mono text-muted-foreground">
                  {i.nodeId ?? (i.field?.startsWith('trigger') ? 'trigger' : 'workflow')}
                </span>
                <span className="w-32 shrink-0 truncate font-mono text-muted-foreground">{i.field ?? ''}</span>
                <span className="flex-1">{i.message}</span>
                {i.start ? (
                  <span className="font-mono text-muted-foreground">
                    {i.start.line}:{i.start.col}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
