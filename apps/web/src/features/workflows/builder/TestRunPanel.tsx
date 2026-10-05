import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { RunDetailDto, Trigger } from '@bop/contracts';
import { Alert, Button, Field, NativeSelect, Segmented, Spinner, Textarea } from '@bop/ui';
import { CircleAlert, ExternalLink, FlaskConical, Play, X } from 'lucide-react';
import { RecordPicker } from '../../../components/pickers';
import { durationMs } from '../../../lib/format';
import type { RecordEntity } from '../../../lib/query-keys';
import { StatusBadge, isTerminal, stepsByNode } from '../runs/run-utils';
import { StepDetail } from '../runs/StepDetail';

export interface TestRunRequest {
  recordId?: string;
  payload?: Record<string, unknown>;
  approvals: 'approve' | 'reject';
}

function samplePayload(trigger: Trigger): string {
  if (trigger.type === 'manual') {
    const input: Record<string, unknown> = {};
    for (const i of trigger.inputs ?? [])
      input[i.key] =
        i.type === 'number' ? 0 : i.type === 'bool' ? false : i.type === 'date' ? new Date().toISOString() : '';
    return JSON.stringify({ input }, null, 2);
  }
  if (trigger.type === 'webhook') {
    const props = (trigger.schema?.['properties'] ?? {}) as Record<string, { type?: string }>;
    const sample: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props))
      sample[k] =
        v.type === 'number' || v.type === 'integer'
          ? 0
          : v.type === 'boolean'
            ? false
            : v.type === 'array'
              ? []
              : v.type === 'object'
                ? {}
                : '';
    return JSON.stringify(sample, null, 2);
  }
  return '{}';
}

export function TestRunPanel({
  trigger,
  run,
  starting,
  error,
  selectedNodeId,
  onStart,
  onClose,
}: {
  trigger: Trigger;
  run: RunDetailDto | undefined;
  starting: boolean;
  error: string | null;
  selectedNodeId: string | null;
  onStart(req: TestRunRequest): void;
  onClose(): void;
}) {
  const entity = 'entity' in trigger && trigger.entity ? (trigger.entity as RecordEntity) : null;
  const [source, setSource] = useState<'record' | 'payload'>(entity ? 'record' : 'payload');
  const [recordId, setRecordId] = useState<string | null>(null);
  const [payload, setPayload] = useState(() => samplePayload(trigger));
  const [approvals, setApprovals] = useState<'approve' | 'reject'>('approve');
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  if (source === 'payload') {
    try {
      const v = JSON.parse(payload) as unknown;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) parseError = 'Payload must be a JSON object';
      else parsed = v as Record<string, unknown>;
    } catch (e) {
      parseError = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }
  const canStart = source === 'record' ? recordId !== null : parsed !== null;
  const byNode = run ? stepsByNode(run.steps) : new Map();
  const selectedSteps = selectedNodeId ? (byNode.get(selectedNodeId) ?? []) : [];

  return (
    <div className="grid gap-4" data-testid="test-run-panel">
      <div className="flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg bg-info/15 text-info">
          <FlaskConical className="size-5" />
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold">Test run</p>
          <p className="text-xs text-muted-foreground">
            Runs the current (unsaved) graph. Emails go to Mailpit, HTTP is dry-run, records are not changed.
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close test panel" onClick={onClose}>
          <X />
        </Button>
      </div>
      {entity ? (
        <Segmented<'record' | 'payload'>
          ariaLabel="Test input"
          value={source}
          onChange={setSource}
          options={[
            { value: 'record', label: `Pick a ${entity}` },
            { value: 'payload', label: 'JSON payload' },
          ]}
        />
      ) : null}
      {source === 'record' && entity ? (
        <Field label={`Trigger ${entity}`}>
          <RecordPicker entity={entity} value={recordId} onChange={(id) => setRecordId(id)} testId="test-run-record" />
        </Field>
      ) : (
        <Field label="Payload" error={parseError}>
          <Textarea
            className="min-h-32 font-mono text-xs"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            data-testid="test-run-payload"
          />
        </Field>
      )}
      <Field label="Approval steps" htmlFor="test-approvals">
        <NativeSelect
          id="test-approvals"
          value={approvals}
          onChange={(e) => setApprovals(e.target.value as 'approve' | 'reject')}
          data-testid="test-run-approvals"
        >
          <option value="approve">Auto-approve</option>
          <option value="reject">Auto-reject</option>
        </NativeSelect>
      </Field>
      <Button
        data-testid="wf-test-run-start"
        disabled={!canStart}
        loading={starting}
        onClick={() =>
          onStart({
            recordId: source === 'record' ? (recordId ?? undefined) : undefined,
            payload: source === 'payload' ? (parsed ?? undefined) : undefined,
            approvals,
          })
        }
      >
        <Play /> Start test run
      </Button>
      {error ? (
        <Alert variant="destructive" icon={<CircleAlert />} title="Could not start">
          {error}
        </Alert>
      ) : null}
      {run ? (
        <div className="grid gap-3 rounded-lg border p-3" data-testid="test-run-result" data-run-status={run.status}>
          <div className="flex items-center gap-2">
            <StatusBadge status={run.status} />
            {!isTerminal(run.status) && run.status !== 'waiting' ? <Spinner className="size-3" /> : null}
            <span className="text-xs text-muted-foreground">
              {run.durationMs !== null ? durationMs(run.durationMs) : ''}
            </span>
            <Link
              to="/runs/$id"
              params={{ id: run.id }}
              className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Open replay <ExternalLink className="size-3" />
            </Link>
          </div>
          {run.error ? <p className="text-xs text-destructive">{run.error.message}</p> : null}
          <ul className="grid gap-1 text-xs">
            {run.steps.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <StatusBadge status={s.status} />
                <span className="font-mono">{s.nodeId}</span>
                {s.outcome ? <span className="text-muted-foreground">→ {s.outcome}</span> : null}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {selectedNodeId
              ? `Details of ${selectedNodeId}:`
              : 'Click a node on the canvas to see its input and output.'}
          </p>
          {selectedNodeId ? <StepDetail steps={selectedSteps} /> : null}
        </div>
      ) : null}
    </div>
  );
}
