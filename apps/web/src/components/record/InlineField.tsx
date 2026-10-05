import { useState, type ReactNode } from 'react';
import { cn } from '@bop/ui';
import { Check, Lock, Pencil, X } from 'lucide-react';
import { FieldInput } from '../FieldInput';
import { FieldValue } from '../FieldValue';
import type { FieldSpec } from '../../lib/table';
import { usePresence } from './presence';

export interface InlineFieldProps {
  spec: Pick<FieldSpec, 'key' | 'label' | 'type' | 'options' | 'relationEntity' | 'currency' | 'optionLabels'>;
  value: unknown;
  display?: ReactNode;
  onSave(value: unknown): void;
  readOnly?: boolean;
  currency?: string;
  className?: string;
  layout?: 'stacked' | 'row';
}

const IMMEDIATE = new Set(['select', 'user', 'date', 'bool', 'relation']);

export function InlineField({
  spec,
  value,
  display,
  onSave,
  readOnly,
  currency,
  className,
  layout = 'stacked',
}: InlineFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  const { locks, setEditing: announce } = usePresence();
  const lock = locks[spec.key];

  const start = () => {
    if (readOnly) return;
    setDraft(value);
    setEditing(true);
    announce(spec.key);
  };
  const stop = () => {
    setEditing(false);
    announce(null);
  };
  const commit = (v: unknown) => {
    stop();
    if (JSON.stringify(v ?? null) !== JSON.stringify(value ?? null)) onSave(v);
  };

  return (
    <div
      className={cn(layout === 'row' ? 'grid grid-cols-[140px_1fr] items-center gap-2' : 'grid gap-1', className)}
      data-testid={`inline-${spec.key}`}
    >
      <span className="text-xs font-medium text-muted-foreground">{spec.label}</span>
      {editing ? (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <FieldInput
              spec={spec}
              value={draft}
              autoFocus
              testId={`field-${spec.key}`}
              className="h-8"
              onChange={(v) => {
                setDraft(v);
                if (IMMEDIATE.has(spec.type)) commit(v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit(draft);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  stop();
                }
              }}
            />
          </div>
          {!IMMEDIATE.has(spec.type) ? (
            <button
              type="button"
              aria-label="Save"
              className="cursor-pointer rounded p-1 text-success hover:bg-muted"
              onClick={() => commit(draft)}
            >
              <Check className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Cancel"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={stop}
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={readOnly}
          onClick={start}
          className={cn(
            'group/inline flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
            !readOnly && 'cursor-pointer hover:bg-muted',
            lock && 'ring-1 ring-warning',
          )}
          aria-label={readOnly ? undefined : `Edit ${spec.label}`}
        >
          <span className="min-w-0 flex-1 truncate">
            {display ?? <FieldValue spec={spec} value={value} currency={currency} />}
          </span>
          {lock ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[oklch(0.5_0.12_70)]">
              <Lock className="size-3" /> {lock.name}
            </span>
          ) : !readOnly ? (
            <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/inline:opacity-100" />
          ) : null}
        </button>
      )}
    </div>
  );
}
