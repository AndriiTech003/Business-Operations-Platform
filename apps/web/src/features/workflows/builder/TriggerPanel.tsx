import { useEffect, useMemo, useRef, useState } from 'react';
import { T } from '@ashamrai/expr';
import {
  ENTITY_EVENTS,
  TRIGGER_ENTITIES,
  type DomainEventType,
  type Trigger,
  type TriggerEntity,
  type ValidationIssue,
  type WorkflowDefinition,
} from '@bop/contracts';
import { triggerVars, type CustomFieldMap } from '@bop/workflow-core';
import { Button, Checkbox, Input, NativeSelect, Textarea, toast } from '@bop/ui';
import { Copy, Plus, Trash2, Zap } from 'lucide-react';
import { ExpressionEditor, type ExpressionEditorHandle } from '../../../lib/expr-editor';
import { FieldRow, IssueList, issuesForField, type FocusRequest } from './PropertiesPanel';

type ManualInput = { key: string; label: string; type: 'string' | 'number' | 'bool' | 'date'; required: boolean };

const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
  { label: '1st of the month', cron: '0 9 1 * *' },
];

export function defaultTrigger(type: Trigger['type'], prev: Trigger): Trigger {
  const entity: TriggerEntity = 'entity' in prev && prev.entity ? prev.entity : 'deal';
  switch (type) {
    case 'record_event':
      return { type, entity, event: (ENTITY_EVENTS[entity]?.[0] ?? 'deal.created') as DomainEventType };
    case 'record_condition':
      return { type, entity, condition: '', dedupe: `${entity}.id` };
    case 'schedule':
      return { type, cron: '0 9 * * 1' };
    case 'webhook':
      return { type, schema: { type: 'object', properties: {} } };
    case 'manual':
      return { type, entity, inputs: [] };
  }
}

export function TriggerPanel({
  definition,
  onChange,
  custom,
  issues,
  webhookUrl,
  focus,
  readOnly = false,
  timezone,
}: {
  definition: WorkflowDefinition;
  onChange(trigger: Trigger, tag: string): void;
  custom: CustomFieldMap;
  issues: ValidationIssue[];
  webhookUrl?: string;
  focus?: FocusRequest | null;
  readOnly?: boolean;
  timezone: string;
}) {
  const trigger = definition.trigger;
  const ctx = useMemo(() => ({ vars: triggerVars(definition, { custom }) }), [definition, custom]);
  const editors = useRef<Record<string, ExpressionEditorHandle | null>>({});
  const [schemaText, setSchemaText] = useState(() =>
    JSON.stringify(trigger.type === 'webhook' ? (trigger.schema ?? {}) : {}, null, 2),
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const webhookSchema = trigger.type === 'webhook' ? JSON.stringify(trigger.schema ?? {}, null, 2) : '';
  useEffect(() => {
    if (trigger.type === 'webhook')
      setSchemaText((prev) => (prev.trim() === '' || schemaError === null ? webhookSchema : prev));
  }, [webhookSchema, trigger.type, schemaError]);

  useEffect(() => {
    if (!focus || focus.field === null) return;
    const key = focus.field.replace(/^trigger\./, '');
    document.getElementById(`prop-trigger-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const ed = editors.current[key];
    if (ed) setTimeout(() => ed.focus(focus.offset), 50);
  }, [focus]);

  const fieldIssues = (key: string) => issuesForField(issues, `trigger.${key}`);
  const general = issues.filter((i) => i.field === null || i.field === 'trigger' || !i.field.startsWith('trigger.'));
  const set = (patch: Partial<Trigger>, tag: string) => onChange({ ...trigger, ...patch } as Trigger, tag);

  const exprField = (
    key: 'filter' | 'condition' | 'dedupe',
    label: string,
    placeholder: string,
    expected = [T.bool, T.nullable(T.bool)],
    required = false,
    help?: string,
  ) => {
    const value = (trigger as Record<string, unknown>)[key];
    return (
      <FieldRow id={`prop-trigger-${key}`} label={label} required={required} help={help} issues={fieldIssues(key)}>
        <ExpressionEditor
          ref={(h) => {
            editors.current[key] = h;
          }}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => set({ [key]: v === '' && !required ? undefined : v } as Partial<Trigger>, `trigger.${key}`)}
          context={ctx}
          expected={expected}
          placeholder={placeholder}
          testId={`expr-${key}`}
          ariaLabel={label}
          invalid={fieldIssues(key).some((i) => i.severity === 'error')}
          readOnly={readOnly}
        />
      </FieldRow>
    );
  };

  const entitySelect = (optional = false) => {
    const value = 'entity' in trigger ? (trigger.entity ?? '') : '';
    return (
      <FieldRow id="prop-trigger-entity" label="Record type" issues={fieldIssues('entity')}>
        <NativeSelect
          className="h-8"
          data-testid="trigger-entity"
          disabled={readOnly}
          value={value}
          onChange={(e) => {
            const entity = (e.target.value || undefined) as TriggerEntity | undefined;
            if (trigger.type === 'record_event' && entity)
              set(
                { entity, event: (ENTITY_EVENTS[entity]?.[0] ?? trigger.event) as DomainEventType },
                'trigger.entity',
              );
            else set({ entity } as Partial<Trigger>, 'trigger.entity');
          }}
        >
          {optional ? <option value="">Any / none</option> : null}
          {TRIGGER_ENTITIES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </NativeSelect>
      </FieldRow>
    );
  };

  return (
    <div className="grid gap-4" data-testid="trigger-panel">
      <div className="flex items-start gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Zap className="size-5" />
        </span>
        <div>
          <p className="text-sm font-semibold">Trigger</p>
          <p className="text-xs text-muted-foreground">
            What starts this workflow. Variables from the trigger are available to every node.
          </p>
        </div>
      </div>
      <IssueList issues={general} />
      <FieldRow id="prop-trigger-type" label="Type" issues={fieldIssues('type')}>
        <NativeSelect
          className="h-8"
          data-testid="trigger-type"
          disabled={readOnly}
          value={trigger.type}
          onChange={(e) => onChange(defaultTrigger(e.target.value as Trigger['type'], trigger), 'trigger.type')}
        >
          <option value="record_event">Record event — when something happens</option>
          <option value="record_condition">Record condition — when a record matches (scanned every minute)</option>
          <option value="schedule">Schedule — cron</option>
          <option value="webhook">Webhook — external HTTP call</option>
          <option value="manual">Manual — “Run workflow…” button</option>
        </NativeSelect>
      </FieldRow>

      {trigger.type === 'record_event' ? (
        <>
          {entitySelect()}
          <FieldRow id="prop-trigger-event" label="Event" issues={fieldIssues('event')}>
            <NativeSelect
              className="h-8"
              data-testid="trigger-event"
              disabled={readOnly}
              value={trigger.event}
              onChange={(e) => set({ event: e.target.value as DomainEventType }, 'trigger.event')}
            >
              {(ENTITY_EVENTS[trigger.entity] ?? []).map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </NativeSelect>
          </FieldRow>
          {exprField(
            'filter',
            'Only when (filter)',
            `${trigger.entity}.amountCents > 100000`,
            undefined,
            false,
            'Optional boolean expression evaluated against the record.',
          )}
        </>
      ) : null}

      {trigger.type === 'record_condition' ? (
        <>
          {entitySelect()}
          {exprField(
            'condition',
            'Condition',
            `${trigger.entity}.status == 'sent' and ${trigger.entity}.dueDate < now() - days(1)`,
            undefined,
            true,
            'Compiled to SQL and scanned every minute. Supports comparisons, and/or/not, now() ± days().',
          )}
          {exprField('dedupe', 'Run once per (dedupe key)', `${trigger.entity}.id`, [T.string, T.number], false)}
        </>
      ) : null}

      {trigger.type === 'schedule' ? (
        <>
          <FieldRow
            id="prop-trigger-cron"
            label="Cron expression"
            required
            issues={fieldIssues('cron')}
            help="minute hour day month weekday"
          >
            <Input
              className="h-8 font-mono"
              data-testid="trigger-cron"
              disabled={readOnly}
              value={trigger.cron}
              onChange={(e) => set({ cron: e.target.value }, 'trigger.cron')}
            />
          </FieldRow>
          <div className="flex flex-wrap gap-1">
            {CRON_PRESETS.map((p) => (
              <Button
                key={p.cron}
                size="xs"
                variant="outline"
                disabled={readOnly}
                onClick={() => set({ cron: p.cron }, 'trigger.cron')}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <FieldRow
            id="prop-trigger-timezone"
            label="Time zone"
            issues={fieldIssues('timezone')}
            help={`Defaults to the workspace time zone (${timezone}).`}
          >
            <Input
              className="h-8"
              data-testid="trigger-timezone"
              disabled={readOnly}
              placeholder={timezone}
              value={trigger.timezone ?? ''}
              onChange={(e) => set({ timezone: e.target.value || undefined }, 'trigger.timezone')}
            />
          </FieldRow>
        </>
      ) : null}

      {trigger.type === 'webhook' ? (
        <>
          <FieldRow
            id="prop-trigger-url"
            label="Webhook URL"
            issues={[]}
            help="POST JSON to this URL. The body is validated against the schema below and available as `payload`."
          >
            <div className="flex gap-1">
              <Input
                readOnly
                className="h-8 font-mono text-xs"
                value={webhookUrl ?? 'Save the workflow to get a URL'}
                data-testid="webhook-url"
              />
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Copy webhook URL"
                disabled={!webhookUrl}
                onClick={() =>
                  void navigator.clipboard?.writeText(webhookUrl ?? '').then(() => toast.success('Webhook URL copied'))
                }
              >
                <Copy />
              </Button>
            </div>
          </FieldRow>
          <FieldRow id="prop-trigger-schema" label="Payload JSON Schema" issues={fieldIssues('schema')}>
            <Textarea
              className="min-h-40 font-mono text-xs"
              data-testid="trigger-schema"
              disabled={readOnly}
              value={schemaText}
              onChange={(e) => {
                setSchemaText(e.target.value);
                try {
                  const parsed = JSON.parse(e.target.value) as unknown;
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                    throw new Error('Schema must be a JSON object');
                  setSchemaError(null);
                  set({ schema: parsed as Record<string, unknown> }, 'trigger.schema');
                } catch (err) {
                  setSchemaError(err instanceof Error ? err.message : 'Invalid JSON');
                }
              }}
            />
            {schemaError ? <p className="text-[11px] text-destructive">{schemaError}</p> : null}
          </FieldRow>
        </>
      ) : null}

      {trigger.type === 'manual' ? (
        <>
          {entitySelect(true)}
          <FieldRow id="prop-trigger-inputs" label="Inputs (asked when started)" issues={fieldIssues('inputs')}>
            <div className="grid gap-2">
              {(trigger.inputs ?? []).map((inp, i) => {
                const update = (patch: Partial<ManualInput>) =>
                  set(
                    { inputs: (trigger.inputs ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) },
                    'trigger.inputs',
                  );
                return (
                  <div key={i} className="grid grid-cols-[1fr_1fr_90px_auto_auto] items-center gap-1">
                    <Input
                      aria-label="Key"
                      className="h-8 font-mono text-xs"
                      placeholder="key"
                      disabled={readOnly}
                      value={inp.key}
                      onChange={(e) => update({ key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
                    />
                    <Input
                      aria-label="Label"
                      className="h-8 text-xs"
                      placeholder="Label"
                      disabled={readOnly}
                      value={inp.label}
                      onChange={(e) => update({ label: e.target.value })}
                    />
                    <NativeSelect
                      aria-label="Type"
                      className="h-8 text-xs"
                      disabled={readOnly}
                      value={inp.type}
                      onChange={(e) => update({ type: e.target.value as ManualInput['type'] })}
                    >
                      <option value="string">text</option>
                      <option value="number">number</option>
                      <option value="bool">yes/no</option>
                      <option value="date">date</option>
                    </NativeSelect>
                    <label className="flex items-center gap-1 text-[11px]">
                      <Checkbox
                        checked={inp.required === true}
                        disabled={readOnly}
                        onCheckedChange={(v) => update({ required: v === true })}
                      />{' '}
                      req.
                    </label>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Remove input"
                      disabled={readOnly}
                      onClick={() =>
                        set({ inputs: (trigger.inputs ?? []).filter((_, j) => j !== i) }, 'trigger.inputs')
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button
                size="xs"
                variant="outline"
                disabled={readOnly}
                onClick={() =>
                  set(
                    {
                      inputs: [
                        ...(trigger.inputs ?? []),
                        {
                          key: `input_${(trigger.inputs?.length ?? 0) + 1}`,
                          label: 'New input',
                          type: 'string',
                          required: false,
                        },
                      ],
                    },
                    'trigger.inputs',
                  )
                }
              >
                <Plus /> Add input
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Available in expressions as <code className="font-mono">input.&lt;key&gt;</code>.
              </p>
            </div>
          </FieldRow>
        </>
      ) : null}

      <div className="rounded-lg border bg-muted/30 p-3 text-xs">
        <p className="mb-1 font-medium">Available variables</p>
        <div className="flex flex-wrap gap-1 font-mono">
          {Object.keys(ctx.vars).map((v) => (
            <span key={v} className="rounded bg-card px-1.5 py-0.5">
              {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
