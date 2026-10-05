import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analyze, type TypeContext } from '@ashamrai/expr';
import type { ValidationIssue, WorkflowDefinition, WorkflowNode } from '@bop/contracts';
import {
  NODE_REGISTRY,
  UPDATABLE_FIELDS,
  buildGraph,
  customFieldType,
  nodeTypeContext,
  recordEntityOf,
  type ConfigField,
  type CustomFieldMap,
} from '@bop/workflow-core';
import { Badge, Button, Input, Label, NativeSelect, Switch, cn } from '@bop/ui';
import { ChevronDown, CircleAlert, Trash2, TriangleAlert } from 'lucide-react';
import { ExpressionEditor, type ExpressionEditorHandle } from '../../../lib/expr-editor';
import { CATEGORY_TONE, nodeIcon } from './nodes';
import { CasesEditor, FieldMapEditor, HeaderMapEditor, StringListEditor } from './field-editors';

export interface FocusRequest {
  field: string | null;
  offset?: number;
  nonce: number;
}

export function issuesForField(issues: ValidationIssue[], key: string): ValidationIssue[] {
  return issues.filter((i) => i.field === key || (i.field !== null && i.field.startsWith(`${key}.`)));
}

export function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="grid gap-0.5" data-testid="field-issues">
      {issues.map((i, n) => (
        <li
          key={n}
          className={cn(
            'flex items-start gap-1 text-[11px]',
            i.severity === 'error' ? 'text-destructive' : 'text-[oklch(0.5_0.12_70)]',
          )}
        >
          {i.severity === 'error' ? (
            <CircleAlert className="mt-0.5 size-3 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          )}
          <span>
            {i.message}
            {i.start ? (
              <span className="ml-1 font-mono opacity-70">
                ({i.start.line}:{i.start.col})
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

const MULTILINE = new Set(['body', 'description', 'details', 'message', 'input']);

export function FieldRow({
  id,
  label,
  required,
  help,
  children,
  issues,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  children: ReactNode;
  issues: ValidationIssue[];
}) {
  return (
    <div id={id} className="grid gap-1 scroll-mt-4" data-field-row>
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {help ? <p className="text-[11px] text-muted-foreground">{help}</p> : null}
      <IssueList issues={issues} />
    </div>
  );
}

function updatableTypes(node: WorkflowNode, ctx: TypeContext, custom: CustomFieldMap) {
  const src = typeof node.config['record'] === 'string' ? (node.config['record'] as string) : '';
  if (src.trim() === '') return {};
  const entity = recordEntityOf(analyze(src, ctx).type);
  if (entity === null) return {};
  const base = { ...UPDATABLE_FIELDS[entity] };
  for (const d of custom[entity] ?? []) base[`custom.${d.key}`] = customFieldType(d.type);
  return base;
}

export interface PropertiesPanelProps {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  custom: CustomFieldMap;
  emailTemplates: string[];
  issues: ValidationIssue[];
  onChange(node: WorkflowNode, tag: string): void;
  onRename(from: string, to: string): void;
  onDelete(): void;
  focus?: FocusRequest | null;
  readOnly?: boolean;
}

export function PropertiesPanel({
  definition,
  node,
  custom,
  emailTemplates,
  issues,
  onChange,
  onRename,
  onDelete,
  focus,
  readOnly = false,
}: PropertiesPanelProps) {
  const spec = NODE_REGISTRY[node.type];
  const Icon = nodeIcon(node.type);
  const ctx = useMemo(() => {
    try {
      return nodeTypeContext(definition, buildGraph(definition), node.id, { custom });
    } catch {
      return { vars: {} };
    }
  }, [definition, node.id, custom]);
  const editors = useRef<Record<string, ExpressionEditorHandle | null>>({});
  const [idDraft, setIdDraft] = useState(node.id);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => setIdDraft(node.id), [node.id]);

  useEffect(() => {
    if (!focus || focus.field === null) return;
    const top = focus.field.split('.')[0] ?? focus.field;
    const el = document.getElementById(`prop-${top}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const editor = editors.current[focus.field] ?? editors.current[top];
    if (editor) setTimeout(() => editor.focus(focus.offset), 50);
    else el?.querySelector<HTMLElement>('input, select, textarea, .cm-content')?.focus();
  }, [focus]);

  const setConfig = (key: string, value: unknown) => {
    const config = { ...node.config };
    if (value === undefined || value === '' || value === null) delete config[key];
    else config[key] = value;
    onChange({ ...node, config }, `config.${key}`);
  };

  const nodeIssues = issues.filter((i) => i.field === null);
  const idValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(idDraft) && idDraft.length <= 60;
  const idTaken = idDraft !== node.id && definition.nodes.some((n) => n.id === idDraft);

  const renderField = (f: ConfigField) => {
    const value = node.config[f.key];
    const fieldIssues = issuesForField(issues, f.key);
    const invalid = fieldIssues.some((i) => i.severity === 'error');
    const fieldCtx: TypeContext = f.allowSecret ? { ...ctx, allowSecret: true } : ctx;
    let control: ReactNode;
    switch (f.kind) {
      case 'expr':
        control = (
          <ExpressionEditor
            ref={(h) => {
              editors.current[f.key] = h;
            }}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => setConfig(f.key, v)}
            context={fieldCtx}
            expected={f.expected}
            placeholder={f.placeholder}
            testId={`expr-${f.key}`}
            ariaLabel={f.label}
            invalid={invalid}
            readOnly={readOnly}
          />
        );
        break;
      case 'template':
        control = (
          <ExpressionEditor
            ref={(h) => {
              editors.current[f.key] = h;
            }}
            template
            multiline={MULTILINE.has(f.key)}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => setConfig(f.key, v)}
            context={fieldCtx}
            placeholder={f.placeholder ?? 'Text with {{ expressions }}'}
            testId={`expr-${f.key}`}
            ariaLabel={f.label}
            invalid={invalid}
            readOnly={readOnly}
          />
        );
        break;
      case 'number':
        control = (
          <Input
            type="number"
            data-testid={`field-${f.key}`}
            className="h-8"
            disabled={readOnly}
            value={typeof value === 'number' ? String(value) : ''}
            placeholder={f.default !== undefined ? String(f.default) : undefined}
            onChange={(e) => setConfig(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        );
        break;
      case 'select':
      case 'string':
        control = f.options ? (
          <NativeSelect
            data-testid={`field-${f.key}`}
            className="h-8"
            disabled={readOnly}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => setConfig(f.key, e.target.value)}
          >
            <option value="">—</option>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            data-testid={`field-${f.key}`}
            className="h-8"
            disabled={readOnly}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => setConfig(f.key, e.target.value)}
          />
        );
        break;
      case 'bool':
        control = (
          <Switch
            data-testid={`field-${f.key}`}
            disabled={readOnly}
            checked={value === true}
            onCheckedChange={(v) => setConfig(f.key, v ? true : undefined)}
          />
        );
        break;
      case 'email_template':
        control = (
          <NativeSelect
            data-testid={`field-${f.key}`}
            className="h-8"
            disabled={readOnly}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => setConfig(f.key, e.target.value)}
          >
            <option value="">No template (inline subject/body)</option>
            {[...new Set([...emailTemplates, ...(typeof value === 'string' && value !== '' ? [value] : [])])].map(
              (t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ),
            )}
          </NativeSelect>
        );
        break;
      case 'field_map':
        control = (
          <FieldMapEditor
            value={value}
            onChange={(v) => setConfig(f.key, v)}
            context={ctx}
            fieldTypes={updatableTypes(node, ctx, custom)}
            readOnly={readOnly}
          />
        );
        break;
      case 'header_map':
        control = (
          <HeaderMapEditor
            value={value}
            onChange={(v) => setConfig(f.key, Object.keys(v).length === 0 ? undefined : v)}
            context={fieldCtx}
            readOnly={readOnly}
          />
        );
        break;
      case 'cases':
        control = (
          <CasesEditor
            value={value}
            onChange={(v) => setConfig(f.key, v)}
            context={ctx}
            expected={f.expected}
            readOnly={readOnly}
          />
        );
        break;
      case 'string_list':
        control = (
          <StringListEditor
            testId={`field-${f.key}`}
            value={value}
            onChange={(v) => setConfig(f.key, v.length === 0 ? undefined : v)}
            readOnly={readOnly}
          />
        );
        break;
    }
    return (
      <FieldRow
        key={f.key}
        id={`prop-${f.key}`}
        label={f.label}
        required={f.required}
        help={f.help}
        issues={fieldIssues}
      >
        {control}
      </FieldRow>
    );
  };

  return (
    <div className="grid gap-4" data-testid="properties-panel" data-node-id={node.id}>
      <div className="flex items-start gap-2">
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', CATEGORY_TONE[spec.category])}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{spec.label}</p>
          <p className="text-xs text-muted-foreground">{spec.description}</p>
        </div>
        {!readOnly ? (
          <Button size="icon-sm" variant="ghost" aria-label="Delete node" onClick={onDelete} data-testid="delete-node">
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <IssueList issues={nodeIssues} />
      <div className="grid grid-cols-2 gap-2">
        <FieldRow id="prop-$id" label="Node id" issues={[]}>
          <Input
            data-testid="node-id"
            className={cn('h-8 font-mono text-xs', (!idValid || idTaken) && 'border-destructive')}
            value={idDraft}
            disabled={readOnly}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={() => {
              if (idValid && !idTaken && idDraft !== node.id) onRename(node.id, idDraft);
              else setIdDraft(node.id);
            }}
          />
        </FieldRow>
        <FieldRow id="prop-$name" label="Display name" issues={[]}>
          <Input
            data-testid="node-name"
            className="h-8"
            value={node.name ?? ''}
            placeholder={spec.label}
            disabled={readOnly}
            onChange={(e) => onChange({ ...node, name: e.target.value || undefined }, 'name')}
          />
        </FieldRow>
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground">
        Reference this step's output in later nodes as{' '}
        <code className="rounded bg-muted px-1 font-mono">steps.{node.id}.output</code>
      </p>
      {spec.fields.map(renderField)}
      <div className="flex flex-wrap gap-1">
        <span className="text-[11px] text-muted-foreground">Outputs:</span>
        {spec.outputs(node.config).map((o) => (
          <Badge key={o} variant="secondary" className="font-mono">
            {o}
          </Badge>
        ))}
      </div>
      {spec.wait || node.type === 'condition' || node.type === 'switch' || node.type === 'end' ? null : (
        <div className="rounded-lg border">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-xs font-medium"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
          >
            Retries & timeout
            <ChevronDown className={cn('size-4 transition-transform', advanced && 'rotate-180')} />
          </button>
          {advanced ? (
            <div className="grid grid-cols-2 gap-2 border-t p-3">
              <FieldRow id="prop-retry.maxAttempts" label="Max attempts" issues={issuesForField(issues, 'retry')}>
                <Input
                  type="number"
                  className="h-8"
                  disabled={readOnly}
                  placeholder={String(spec.retry.maxAttempts)}
                  value={node.retry?.maxAttempts ?? ''}
                  onChange={(e) =>
                    onChange(
                      {
                        ...node,
                        retry: {
                          ...node.retry,
                          maxAttempts: e.target.value === '' ? undefined : Number(e.target.value),
                        },
                      },
                      'retry',
                    )
                  }
                />
              </FieldRow>
              <FieldRow id="prop-retry.backoff" label="Backoff" issues={[]}>
                <NativeSelect
                  className="h-8"
                  disabled={readOnly}
                  value={node.retry?.backoff ?? ''}
                  onChange={(e) =>
                    onChange(
                      {
                        ...node,
                        retry: {
                          ...node.retry,
                          backoff: e.target.value === '' ? undefined : (e.target.value as 'exponential' | 'fixed'),
                        },
                      },
                      'retry',
                    )
                  }
                >
                  <option value="">default ({spec.retry.backoff})</option>
                  <option value="exponential">exponential</option>
                  <option value="fixed">fixed</option>
                </NativeSelect>
              </FieldRow>
              <FieldRow id="prop-retry.initialMs" label="Initial delay (ms)" issues={[]}>
                <Input
                  type="number"
                  className="h-8"
                  disabled={readOnly}
                  placeholder={String(spec.retry.initialMs)}
                  value={node.retry?.initialMs ?? ''}
                  onChange={(e) =>
                    onChange(
                      {
                        ...node,
                        retry: { ...node.retry, initialMs: e.target.value === '' ? undefined : Number(e.target.value) },
                      },
                      'retry',
                    )
                  }
                />
              </FieldRow>
              <FieldRow id="prop-timeoutMs" label="Timeout (ms)" issues={issuesForField(issues, 'timeoutMs')}>
                <Input
                  type="number"
                  className="h-8"
                  disabled={readOnly}
                  value={node.timeoutMs ?? ''}
                  onChange={(e) =>
                    onChange(
                      { ...node, timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) },
                      'timeoutMs',
                    )
                  }
                />
              </FieldRow>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
