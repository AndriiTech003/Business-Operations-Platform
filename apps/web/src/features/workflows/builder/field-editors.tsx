import { useEffect, useId, useState } from 'react';
import { T, type Type, type TypeContext } from '@ashamrai/expr';
import { Button, Input } from '@bop/ui';
import { Plus, Trash2 } from 'lucide-react';
import { ExpressionEditor } from '../../../lib/expr-editor';

export function CasesEditor({
  value,
  onChange,
  context,
  expected,
  readOnly,
}: {
  value: unknown;
  onChange(v: Array<{ name: string; when: string }>): void;
  context: TypeContext;
  expected?: readonly Type[];
  readOnly?: boolean;
}) {
  const cases = Array.isArray(value)
    ? (value as Array<{ name?: unknown; when?: unknown }>).map((c) => ({
        name: typeof c.name === 'string' ? c.name : '',
        when: typeof c.when === 'string' ? c.when : '',
      }))
    : [];
  const set = (i: number, patch: Partial<{ name: string; when: string }>) =>
    onChange(cases.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="grid gap-2" data-testid="cases-editor">
      {cases.map((c, i) => (
        <div key={i} className="grid gap-1 rounded-md border bg-muted/30 p-2">
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground">case:</span>
            <Input
              aria-label={`Case ${i + 1} name`}
              className="h-7 font-mono text-xs"
              value={c.name}
              disabled={readOnly}
              onChange={(e) => set(i, { name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove case ${c.name}`}
              disabled={readOnly}
              onClick={() => onChange(cases.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
          <ExpressionEditor
            value={c.when}
            onChange={(v) => set(i, { when: v })}
            context={context}
            expected={expected}
            placeholder="condition, e.g. deal.amountCents > 100000"
            testId={`expr-cases.${i}.when`}
            ariaLabel={`Case ${c.name} condition`}
            readOnly={readOnly}
          />
        </div>
      ))}
      <Button
        size="xs"
        variant="outline"
        disabled={readOnly}
        onClick={() => onChange([...cases, { name: `case_${cases.length + 1}`, when: '' }])}
      >
        <Plus /> Add case
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Cases are checked top to bottom; unmatched records follow the “default” edge.
      </p>
    </div>
  );
}

function KeyInput({
  value,
  onCommit,
  listId,
  placeholder,
  readOnly,
  ariaLabel,
}: {
  value: string;
  onCommit(v: string): void;
  listId?: string;
  placeholder?: string;
  readOnly?: boolean;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      aria-label={ariaLabel}
      list={listId}
      className="h-8 font-mono text-xs"
      value={draft}
      placeholder={placeholder}
      disabled={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft !== value ? onCommit(draft.trim()) : undefined)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function renameKey(obj: Record<string, string>, from: string, to: string): Record<string, string> {
  if (to === '' || to === from || to in obj) return obj;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

export function FieldMapEditor({
  value,
  onChange,
  context,
  fieldTypes,
  readOnly,
}: {
  value: unknown;
  onChange(v: Record<string, string>): void;
  context: TypeContext;
  fieldTypes: Record<string, Type>;
  readOnly?: boolean;
}) {
  const listId = useId();
  const obj: Record<string, string> =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
        )
      : {};
  const keys = Object.keys(fieldTypes);
  const nextKey = keys.find((k) => !(k in obj)) ?? `field_${Object.keys(obj).length + 1}`;
  return (
    <div className="grid gap-2" data-testid="field-map-editor">
      <datalist id={listId}>
        {keys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {Object.entries(obj).map(([k, v]) => {
        const t = fieldTypes[k];
        return (
          <div key={k} className="grid gap-1 rounded-md border bg-muted/30 p-2">
            <div className="flex items-center gap-1">
              <KeyInput
                ariaLabel="Field name"
                value={k}
                listId={listId}
                placeholder="field or custom.key"
                readOnly={readOnly}
                onCommit={(nk) => onChange(renameKey(obj, k, nk))}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${k}`}
                disabled={readOnly}
                onClick={() => {
                  const next = { ...obj };
                  delete next[k];
                  onChange(next);
                }}
              >
                <Trash2 />
              </Button>
            </div>
            <ExpressionEditor
              value={v}
              onChange={(nv) => onChange({ ...obj, [k]: nv })}
              context={context}
              expected={
                t === undefined
                  ? undefined
                  : t.kind === 'money'
                    ? [T.money, T.number, T.nullable(T.money)]
                    : [t, T.nullable(t), T.null]
              }
              testId={`expr-fields.${k}`}
              ariaLabel={`Value for ${k}`}
              placeholder="expression"
              readOnly={readOnly}
            />
          </div>
        );
      })}
      <Button
        size="xs"
        variant="outline"
        disabled={readOnly}
        onClick={() => onChange({ ...obj, [nextKey]: '' })}
        data-testid="field-map-add"
      >
        <Plus /> Add field
      </Button>
    </div>
  );
}

export function HeaderMapEditor({
  value,
  onChange,
  context,
  readOnly,
}: {
  value: unknown;
  onChange(v: Record<string, string>): void;
  context: TypeContext;
  readOnly?: boolean;
}) {
  const obj: Record<string, string> =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
        )
      : {};
  return (
    <div className="grid gap-2">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[120px_1fr_auto] items-start gap-1">
          <KeyInput
            ariaLabel="Header name"
            value={k}
            readOnly={readOnly}
            onCommit={(nk) => onChange(renameKey(obj, k, nk))}
          />
          <ExpressionEditor
            value={v}
            template
            onChange={(nv) => onChange({ ...obj, [k]: nv })}
            context={context}
            testId={`expr-headers.${k}`}
            ariaLabel={`Header ${k}`}
            readOnly={readOnly}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove header ${k}`}
            disabled={readOnly}
            onClick={() => {
              const next = { ...obj };
              delete next[k];
              onChange(next);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        size="xs"
        variant="outline"
        disabled={readOnly}
        onClick={() => {
          let n = 1;
          while (`X-Header-${n}` in obj) n++;
          onChange({ ...obj, [`X-Header-${n}`]: '' });
        }}
      >
        <Plus /> Add header
      </Button>
    </div>
  );
}

export function StringListEditor({
  value,
  onChange,
  readOnly,
  testId,
}: {
  value: unknown;
  onChange(v: string[]): void;
  readOnly?: boolean;
  testId?: string;
}) {
  const list = Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const joined = list.join(', ');
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined]);
  return (
    <Input
      data-testid={testId}
      value={draft}
      disabled={readOnly}
      placeholder="comma, separated, values"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() =>
        onChange(
          draft
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}
