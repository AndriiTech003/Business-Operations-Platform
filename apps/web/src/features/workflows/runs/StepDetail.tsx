import type { ReactNode } from 'react';
import type { MemberDto, StepRunDto } from '@bop/contracts';
import { Alert, Badge, Button } from '@bop/ui';
import { Clock, Hourglass, KeyRound, RotateCcw, ShieldAlert, UserCheck } from 'lucide-react';
import { countdown, durationMs, fmtDateTime } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import { useMemberMap } from '../../../lib/data';
import { StatusBadge } from './run-utils';

export function Json({ value, className }: { value: unknown; className?: string }) {
  if (value === undefined || value === null) return <p className="text-xs text-muted-foreground">—</p>;
  return (
    <pre
      className={`max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed ${className ?? ''}`}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function OutputPreview({ nodeType, output }: { nodeType: string; output: unknown }) {
  const o = asObj(output);
  if (o === null) return <Json value={output} />;
  const html = typeof o['html'] === 'string' ? (o['html'] as string) : null;
  const request = asObj(o['request']);
  const changes = asObj(o['changes']) ?? asObj(o['diff']);
  return (
    <div className="grid gap-2" data-testid="output-preview">
      {o['dryRun'] === true ? (
        <Badge variant="info" className="w-fit">
          dry run — nothing was sent or changed
        </Badge>
      ) : null}
      {nodeType === 'send_email' || html !== null ? (
        <div className="overflow-hidden rounded-md border">
          <div className="grid gap-0.5 border-b bg-muted/40 px-2 py-1.5 text-[11px]">
            {Array.isArray(o['to']) ? <span>To: {(o['to'] as string[]).join(', ')}</span> : null}
            {typeof o['subject'] === 'string' ? (
              <span className="font-medium">Subject: {o['subject'] as string}</span>
            ) : null}
          </div>
          {html !== null ? (
            <iframe title="Email preview" sandbox="" srcDoc={html} className="h-56 w-full bg-white" />
          ) : null}
        </div>
      ) : null}
      {request !== null ? (
        <div className="grid gap-1">
          <p className="font-mono text-[11px]">
            <span className="font-semibold">{String(request['method'] ?? 'POST')}</span> {String(request['url'] ?? '')}
          </p>
          <Json value={{ headers: request['headers'], body: request['body'] }} />
        </div>
      ) : null}
      {changes !== null ? (
        <table className="w-full overflow-hidden rounded-md border text-[11px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-2 py-1 text-left">Field</th>
              <th className="px-2 py-1 text-left">Before</th>
              <th className="px-2 py-1 text-left">After</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(changes).map(([k, v]) => {
              const c = asObj(v);
              return (
                <tr key={k} className="border-t">
                  <td className="px-2 py-1 font-mono">{k}</td>
                  <td className="px-2 py-1 text-muted-foreground line-through">
                    {JSON.stringify(c?.['from'] ?? null)}
                  </td>
                  <td className="px-2 py-1">{JSON.stringify(c !== null && 'to' in c ? c['to'] : v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <Json value={output} />
    </div>
  );
}

function WaitInfo({ step, members }: { step: StepRunDto; members: Map<string, MemberDto> }) {
  const now = useNow(1000);
  const wait = step.wait ?? {};
  const kind = wait['kind'];
  if (step.status !== 'waiting' && step.status !== 'pending') return null;
  if (kind === 'approval') {
    const ids = Array.isArray(wait['assigneeIds']) ? (wait['assigneeIds'] as string[]) : [];
    const names = ids.map((id) => members.get(id)?.name ?? 'someone');
    return (
      <Alert variant="warning" icon={<UserCheck />} title="Waiting for approval" className="text-xs">
        from: {names.length > 0 ? names.join(', ') : 'approvers'}
        {typeof wait['expiresAt'] === 'string' ? ` · times out in ${countdown(wait['expiresAt'] as string, now)}` : ''}
      </Alert>
    );
  }
  if (kind === 'event') {
    return (
      <Alert
        variant="warning"
        icon={<Hourglass />}
        title={`Waiting for ${String(wait['event'] ?? 'event')}`}
        className="text-xs"
      >
        {typeof wait['expiresAt'] === 'string'
          ? `timeout fires in ${countdown(wait['expiresAt'] as string, now)}`
          : 'no timeout'}
      </Alert>
    );
  }
  if (step.scheduledFor) {
    return (
      <Alert
        variant="info"
        icon={<Clock />}
        title={`Fires in ${countdown(step.scheduledFor, now)}`}
        className="text-xs"
      >
        <span data-testid="fires-in">scheduled for {fmtDateTime(step.scheduledFor)}</span>
      </Alert>
    );
  }
  return null;
}

export function StepDetail({
  steps,
  onRetry,
  retrying,
}: {
  steps: StepRunDto[];
  onRetry?(step: StepRunDto): void;
  retrying?: boolean;
}) {
  const members = useMemberMap();
  if (steps.length === 0)
    return <p className="text-sm text-muted-foreground">This node was not reached in this run.</p>;
  return (
    <div className="grid gap-4" data-testid="step-detail">
      {steps.map((step) => (
        <div key={step.id} className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={step.status} />
            {steps.length > 1 ? <Badge variant="outline">iteration {step.iteration}</Badge> : null}
            {step.outcome ? (
              <Badge variant="secondary" className="font-mono">
                → {step.outcome}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              attempt {step.attempt}/{step.maxAttempts}
            </span>
            {step.status === 'failed' && onRetry ? (
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                loading={retrying}
                onClick={() => onRetry(step)}
                data-testid="retry-step"
              >
                <RotateCcw /> Retry step
              </Button>
            ) : null}
          </div>
          <WaitInfo step={step} members={members} />
          {step.error ? (
            <Alert variant="destructive" icon={<ShieldAlert />} title={step.error.code ?? 'Error'}>
              {step.error.message}
              {step.error.retryable !== undefined ? ` · ${step.error.retryable ? 'retryable' : 'permanent'}` : ''}
            </Alert>
          ) : null}
          <Section title="Input">
            <Json value={step.input} />
          </Section>
          <Section title="Output">
            {step.output === null || step.output === undefined ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              <OutputPreview nodeType={step.nodeType} output={step.output} />
            )}
          </Section>
          <Section title="Attempts">
            {step.attempts.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not started yet</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium">#</th>
                    <th className="text-left font-medium">Started</th>
                    <th className="text-left font-medium">Duration</th>
                    <th className="text-left font-medium">Worker</th>
                    <th className="text-left font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {step.attempts.map((a) => (
                    <tr key={a.attempt} className="border-t align-top">
                      <td className="py-1">{a.attempt}</td>
                      <td className="py-1">{fmtDateTime(a.startedAt)}</td>
                      <td className="py-1">
                        {a.startedAt && a.finishedAt
                          ? durationMs(new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime())
                          : '—'}
                      </td>
                      <td className="py-1 font-mono">{a.worker ?? '—'}</td>
                      <td className="py-1">
                        {a.error ? (
                          <span className="text-destructive">{a.error.message}</span>
                        ) : a.finishedAt ? (
                          'ok'
                        ) : (
                          'running'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <p className="flex items-center gap-1 break-all font-mono text-[10.5px] text-muted-foreground">
            <KeyRound className="size-3 shrink-0" /> {step.idempotencyKey}
          </p>
        </div>
      ))}
    </div>
  );
}
