import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { NodeType, StepStatus, Trigger, WorkflowNode } from '@bop/contracts';
import { NODE_REGISTRY } from '@bop/workflow-core';
import { cn } from '@bop/ui';
import {
  Bell,
  CalendarClock,
  CircleAlert,
  CircleStop,
  FileText,
  GitBranch,
  Globe,
  type LucideIcon,
  Mail,
  Pencil,
  Radio,
  Repeat,
  Sparkles,
  Split,
  SquareCheck,
  StickyNote,
  Timer,
  UserCheck,
  Zap,
} from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = {
  'git-branch': GitBranch,
  split: Split,
  'check-square': SquareCheck,
  pencil: Pencil,
  'sticky-note': StickyNote,
  bell: Bell,
  'file-text': FileText,
  mail: Mail,
  globe: Globe,
  timer: Timer,
  'calendar-clock': CalendarClock,
  radio: Radio,
  'user-check': UserCheck,
  repeat: Repeat,
  sparkles: Sparkles,
  'circle-stop': CircleStop,
};

export function nodeIcon(type: NodeType): LucideIcon {
  return ICONS[NODE_REGISTRY[type].icon] ?? Zap;
}

export const CATEGORY_TONE: Record<string, string> = {
  logic: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  action: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  wait: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  human: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  integration: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  flow: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export const STATUS_RING: Record<string, string> = {
  succeeded: 'ring-2 ring-success border-success',
  failed: 'ring-2 ring-destructive border-destructive',
  running: 'ring-2 ring-info border-info animate-pulse-ring',
  waiting: 'ring-2 ring-warning border-warning',
  pending: 'ring-2 ring-info/40 border-info/50',
  skipped: 'border-dashed opacity-60',
  cancelled: 'opacity-60 border-muted-foreground',
};

export const STATUS_DOT: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  running: 'bg-info animate-pulse',
  waiting: 'bg-warning',
  pending: 'bg-info/50',
  skipped: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground',
};

export type WfNodeData = {
  node: WorkflowNode;
  status?: StepStatus;
  issues: number;
  errorIssues: number;
  vertical: boolean;
  readOnly: boolean;
};

export type TriggerNodeData = {
  trigger: Trigger;
  issues: number;
  vertical: boolean;
  status?: StepStatus;
};

export type WfFlowNode = Node<WfNodeData, 'wf'>;
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>;
export type AnyFlowNode = WfFlowNode | TriggerFlowNode;

function summary(node: WorkflowNode): string {
  const c = node.config;
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  switch (node.type) {
    case 'condition':
      return s('expr');
    case 'switch':
      return Array.isArray(c['cases']) ? `${(c['cases'] as unknown[]).length} cases` : '';
    case 'send_email':
      return s('template') ? `template: ${s('template')}` : s('subject');
    case 'wait_duration':
      return s('duration');
    case 'wait_until':
      return s('until');
    case 'wait_for_event':
      return `${s('event')}${s('timeout') ? ` · timeout ${s('timeout')}` : ''}`;
    case 'approval':
      return s('assignees');
    case 'http_request':
      return `${s('method') || 'POST'} ${s('url')}`;
    case 'update_record':
      return `${s('record')}: ${Object.keys((c['fields'] as Record<string, unknown>) ?? {}).join(', ')}`;
    case 'notify':
      return s('to');
    case 'create_task':
      return s('title');
    case 'for_each':
      return s('items');
    default:
      return '';
  }
}

const OUTCOME_COLOR: Record<string, string> = {
  true: '!bg-success',
  approved: '!bg-success',
  false: '!bg-destructive/70',
  rejected: '!bg-destructive/70',
  error: '!bg-destructive',
  timeout: '!bg-warning',
};

export const WorkflowNodeView = memo(function WorkflowNodeView({ data, selected }: NodeProps<WfFlowNode>) {
  const { node, status, issues, errorIssues, vertical } = data;
  const spec = NODE_REGISTRY[node.type];
  const Icon = nodeIcon(node.type);
  const outputs = spec.outputs(node.config);
  const sub = summary(node);
  return (
    <div
      data-testid={`wf-node-${node.id}`}
      data-status={status ?? 'idle'}
      data-node-type={node.type}
      data-invalid={errorIssues > 0 || undefined}
      className={cn(
        'relative w-[230px] rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-shadow',
        selected && 'shadow-md outline-2 outline-offset-2 outline-primary',
        errorIssues > 0 && !status && 'border-destructive ring-1 ring-destructive/40',
        status ? STATUS_RING[status] : undefined,
      )}
    >
      <Handle
        type="target"
        position={vertical ? Position.Top : Position.Left}
        className="!size-2.5 !border-2 !border-card !bg-muted-foreground"
      />
      <div className="flex items-center gap-2">
        <span
          className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', CATEGORY_TONE[spec.category])}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight">{node.name || spec.label}</p>
          <p className="truncate font-mono text-[10.5px] text-muted-foreground">{node.id}</p>
        </div>
        {status ? <span className={cn('size-2.5 shrink-0 rounded-full', STATUS_DOT[status])} title={status} /> : null}
        {issues > 0 ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold',
              errorIssues > 0 ? 'bg-destructive text-white' : 'bg-warning text-black',
            )}
            title={`${issues} issue(s)`}
          >
            <CircleAlert className="size-3" />
            {issues}
          </span>
        ) : null}
      </div>
      {sub ? (
        <p className="mt-1.5 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          {sub}
        </p>
      ) : null}
      {outputs.map((o, i) => {
        const offset = `${((i + 1) / (outputs.length + 1)) * 100}%`;
        return (
          <Handle
            key={o}
            id={o}
            type="source"
            position={vertical ? Position.Bottom : Position.Right}
            style={vertical ? { left: offset } : { top: offset }}
            className={cn(
              '!size-2.5 !border-2 !border-card !bg-primary',
              OUTCOME_COLOR[o.startsWith('case:') ? 'case' : o],
            )}
            title={o}
          >
            {outputs.length > 1 || o !== 'next' ? (
              <span
                className={cn(
                  'pointer-events-none absolute whitespace-nowrap text-[9.5px] font-medium text-muted-foreground',
                  vertical ? 'left-1/2 top-2.5 -translate-x-1/2' : 'left-3 top-1/2 -translate-y-1/2',
                )}
              >
                {o}
              </span>
            ) : null}
          </Handle>
        );
      })}
    </div>
  );
});

const TRIGGER_LABEL: Record<string, string> = {
  record_event: 'Record event',
  record_condition: 'Record condition',
  schedule: 'Schedule',
  webhook: 'Webhook',
  manual: 'Manual',
};

function triggerSummary(t: Trigger): string {
  switch (t.type) {
    case 'record_event':
      return t.event;
    case 'record_condition':
      return t.condition;
    case 'schedule':
      return `${t.cron}${t.timezone ? ` (${t.timezone})` : ''}`;
    case 'webhook':
      return 'POST /hooks/…';
    case 'manual':
      return t.entity ? `on ${t.entity}` : 'run by a person';
  }
}

export const TriggerNodeView = memo(function TriggerNodeView({ data, selected }: NodeProps<TriggerFlowNode>) {
  return (
    <div
      data-testid="wf-node-$trigger"
      data-status={data.status ?? 'idle'}
      className={cn(
        'relative w-[230px] rounded-xl border-2 border-primary/40 bg-gradient-to-br from-primary/10 to-card px-3 py-2.5 shadow-sm',
        selected && 'outline-2 outline-offset-2 outline-primary',
        data.issues > 0 && 'border-destructive',
        data.status === 'succeeded' && 'border-success',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Zap className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">Trigger</p>
          <p className="truncate text-[13px] font-semibold leading-tight">{TRIGGER_LABEL[data.trigger.type]}</p>
        </div>
        {data.issues > 0 ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white">
            <CircleAlert className="size-3" />
            {data.issues}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 truncate rounded bg-card/70 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
        {triggerSummary(data.trigger)}
      </p>
      <Handle
        id="next"
        type="source"
        position={data.vertical ? Position.Bottom : Position.Right}
        className="!size-2.5 !border-2 !border-card !bg-primary"
      />
    </div>
  );
});

export const nodeTypes = { wf: WorkflowNodeView, trigger: TriggerNodeView };
