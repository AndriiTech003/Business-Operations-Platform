import { T, type Type } from '@ashamrai/expr';
import { DOMAIN_EVENTS, TRIGGER_ENTITIES, type NodeType, type RetryPolicy, type WorkflowNode } from '@bop/contracts';
import { entityType, type CustomFieldMap } from './entities';

export type ConfigFieldKind =
  | 'expr'
  | 'template'
  | 'string'
  | 'number'
  | 'select'
  | 'bool'
  | 'email_template'
  | 'field_map'
  | 'header_map'
  | 'cases'
  | 'string_list';

export interface ConfigField {
  key: string;
  label: string;
  kind: ConfigFieldKind;
  required?: boolean;
  expected?: Type[];
  options?: readonly string[];
  help?: string;
  placeholder?: string;
  allowSecret?: boolean;
  default?: unknown;
}

export type NodeCategory = 'logic' | 'action' | 'wait' | 'human' | 'integration' | 'flow';

export interface NodeSpec {
  type: NodeType;
  label: string;
  category: NodeCategory;
  icon: string;
  description: string;
  fields: ConfigField[];
  outputs(config: Record<string, unknown>): string[];
  defaultOutput: string | null;
  errorEdge: boolean;
  outputType(config: Record<string, unknown>, ctx: OutputTypeContext): Type;
  retry: RetryPolicy;
  external: boolean;
  wait: boolean;
}

export interface OutputTypeContext {
  custom: CustomFieldMap;
  itemType?: Type;
}

const recipients: Type[] = [
  T.string,
  T.user,
  T.list(T.user),
  T.list(T.string),
  T.nullable(T.string),
  T.nullable(T.user),
];
const recordTypes: Type[] = [T.any];
const NO_RETRY: RetryPolicy = { maxAttempts: 1, backoff: 'fixed', initialMs: 1000 };
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoff: 'exponential', initialMs: 1000, maxMs: 60_000 };
const EXTERNAL_RETRY: RetryPolicy = { maxAttempts: 5, backoff: 'exponential', initialMs: 2000, maxMs: 300_000 };

function casesOf(config: Record<string, unknown>): string[] {
  const cases = Array.isArray(config['cases']) ? (config['cases'] as Array<{ name?: unknown }>) : [];
  return cases.map((c) => (typeof c.name === 'string' ? c.name : '')).filter((n) => n.length > 0);
}

const ENTITY_SELECT = TRIGGER_ENTITIES;

export const NODE_REGISTRY: Record<NodeType, NodeSpec> = {
  condition: {
    type: 'condition',
    label: 'Condition',
    category: 'logic',
    icon: 'git-branch',
    description: 'Branch on a boolean expression.',
    fields: [
      {
        key: 'expr',
        label: 'Condition',
        kind: 'expr',
        required: true,
        expected: [T.bool, T.nullable(T.bool)],
        placeholder: 'invoice.totalCents > 100000',
      },
    ],
    outputs: () => ['true', 'false'],
    defaultOutput: null,
    errorEdge: false,
    outputType: () => T.object({ result: { type: T.bool } }),
    retry: NO_RETRY,
    external: false,
    wait: false,
  },
  switch: {
    type: 'switch',
    label: 'Switch',
    category: 'logic',
    icon: 'split',
    description: 'Route to the first case whose condition is true.',
    fields: [
      {
        key: 'cases',
        label: 'Cases',
        kind: 'cases',
        required: true,
        expected: [T.bool, T.nullable(T.bool)],
        help: 'Each case has a name and a boolean expression.',
      },
    ],
    outputs: (config) => [...casesOf(config).map((name) => `case:${name}`), 'default'],
    defaultOutput: null,
    errorEdge: false,
    outputType: () => T.object({ case: { type: T.string } }),
    retry: NO_RETRY,
    external: false,
    wait: false,
  },
  create_task: {
    type: 'create_task',
    label: 'Create task',
    category: 'action',
    icon: 'check-square',
    description: 'Create a task, optionally linked to a record.',
    fields: [
      { key: 'title', label: 'Title', kind: 'template', required: true },
      { key: 'description', label: 'Description', kind: 'template' },
      {
        key: 'assignee',
        label: 'Assignee',
        kind: 'expr',
        expected: [T.user, T.nullable(T.user), T.string, T.nullable(T.string), T.list(T.user)],
      },
      {
        key: 'dueAt',
        label: 'Due',
        kind: 'expr',
        expected: [T.date, T.nullable(T.date)],
        placeholder: 'now() + days(1)',
      },
      { key: 'priority', label: 'Priority (1-4)', kind: 'number', default: 2 },
      { key: 'relatedTo', label: 'Related record', kind: 'expr', expected: recordTypes, placeholder: 'invoice' },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: (_c, ctx) => entityType('task', ctx.custom),
    retry: DEFAULT_RETRY,
    external: false,
    wait: false,
  },
  update_record: {
    type: 'update_record',
    label: 'Update record',
    category: 'action',
    icon: 'pencil',
    description: 'Update fields of a record (stage, amount, owner, custom fields).',
    fields: [
      { key: 'record', label: 'Record', kind: 'expr', required: true, expected: recordTypes, placeholder: 'deal' },
      {
        key: 'fields',
        label: 'Fields',
        kind: 'field_map',
        required: true,
        help: 'Field name → expression. Custom fields as custom.<key>.',
      },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () =>
      T.object({ id: { type: T.string }, entity: { type: T.string }, changed: { type: T.list(T.string) } }),
    retry: DEFAULT_RETRY,
    external: false,
    wait: false,
  },
  add_note: {
    type: 'add_note',
    label: 'Add note',
    category: 'action',
    icon: 'sticky-note',
    description: 'Add a note to the activity timeline of a record.',
    fields: [
      { key: 'subject', label: 'Record', kind: 'expr', required: true, expected: recordTypes, placeholder: 'deal' },
      { key: 'body', label: 'Note', kind: 'template', required: true },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () => T.object({ id: { type: T.string } }),
    retry: DEFAULT_RETRY,
    external: false,
    wait: false,
  },
  notify: {
    type: 'notify',
    label: 'Notify',
    category: 'action',
    icon: 'bell',
    description: 'In-app notification (realtime) to users.',
    fields: [
      {
        key: 'to',
        label: 'Recipients',
        kind: 'expr',
        required: true,
        expected: recipients,
        placeholder: 'invoice.company.owner',
      },
      { key: 'message', label: 'Message', kind: 'template', required: true },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () => T.object({ notified: { type: T.list(T.string) } }),
    retry: DEFAULT_RETRY,
    external: false,
    wait: false,
  },
  create_invoice: {
    type: 'create_invoice',
    label: 'Create invoice draft',
    category: 'action',
    icon: 'file-text',
    description: 'Create a draft invoice for a company (e.g. from a won deal).',
    fields: [
      {
        key: 'company',
        label: 'Company',
        kind: 'expr',
        required: true,
        expected: recordTypes,
        placeholder: 'deal.company',
      },
      { key: 'contact', label: 'Contact', kind: 'expr', expected: recordTypes, placeholder: 'deal.contact' },
      { key: 'deal', label: 'Deal', kind: 'expr', expected: recordTypes, placeholder: 'deal' },
      { key: 'description', label: 'Line description', kind: 'template', required: true },
      {
        key: 'amount',
        label: 'Amount',
        kind: 'expr',
        required: true,
        expected: [T.money, T.number],
        placeholder: 'deal.amountCents',
      },
      { key: 'dueIn', label: 'Due in', kind: 'expr', expected: [T.duration], placeholder: 'days(14)' },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: (_c, ctx) => entityType('invoice', ctx.custom),
    retry: DEFAULT_RETRY,
    external: false,
    wait: false,
  },
  send_email: {
    type: 'send_email',
    label: 'Send email',
    category: 'action',
    icon: 'mail',
    description: 'Send an email from a template or inline subject and body.',
    fields: [
      {
        key: 'to',
        label: 'To',
        kind: 'expr',
        required: true,
        expected: recipients,
        placeholder: 'invoice.contact.email',
      },
      { key: 'template', label: 'Template', kind: 'email_template' },
      { key: 'subject', label: 'Subject (without template)', kind: 'template' },
      { key: 'body', label: 'Body (without template)', kind: 'template' },
      { key: 'attachInvoice', label: 'Attach invoice PDF', kind: 'bool' },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () => T.object({ messageId: { type: T.string }, to: { type: T.list(T.string) } }),
    retry: EXTERNAL_RETRY,
    external: true,
    wait: false,
  },
  http_request: {
    type: 'http_request',
    label: 'HTTP request',
    category: 'integration',
    icon: 'globe',
    description: "Call an external API. Secrets via secret('name').",
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        default: 'POST',
      },
      { key: 'url', label: 'URL', kind: 'template', required: true, allowSecret: true },
      { key: 'headers', label: 'Headers', kind: 'header_map', allowSecret: true },
      { key: 'body', label: 'Body (JSON template)', kind: 'template', allowSecret: true },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () => T.object({ status: { type: T.number }, body: { type: T.any } }),
    retry: EXTERNAL_RETRY,
    external: true,
    wait: false,
  },
  wait_duration: {
    type: 'wait_duration',
    label: 'Wait',
    category: 'wait',
    icon: 'timer',
    description: 'Pause for a duration (survives restarts).',
    fields: [
      {
        key: 'duration',
        label: 'Duration',
        kind: 'expr',
        required: true,
        expected: [T.duration],
        placeholder: 'days(3)',
      },
    ],
    outputs: () => ['next'],
    defaultOutput: 'next',
    errorEdge: false,
    outputType: () => T.object({ resumedAt: { type: T.date } }),
    retry: NO_RETRY,
    external: false,
    wait: true,
  },
  wait_until: {
    type: 'wait_until',
    label: 'Wait until',
    category: 'wait',
    icon: 'calendar-clock',
    description: 'Pause until a point in time.',
    fields: [
      {
        key: 'until',
        label: 'Until',
        kind: 'expr',
        required: true,
        expected: [T.date, T.nullable(T.date)],
        placeholder: 'invoice.dueDate + days(7)',
      },
    ],
    outputs: () => ['next'],
    defaultOutput: 'next',
    errorEdge: false,
    outputType: () => T.object({ resumedAt: { type: T.date } }),
    retry: NO_RETRY,
    external: false,
    wait: true,
  },
  wait_for_event: {
    type: 'wait_for_event',
    label: 'Wait for event',
    category: 'wait',
    icon: 'radio',
    description: 'Wait for a domain event on a record, with a timeout.',
    fields: [
      { key: 'entity', label: 'Entity', kind: 'select', options: ENTITY_SELECT, required: true },
      { key: 'id', label: 'Record id', kind: 'expr', required: true, expected: [T.string], placeholder: 'invoice.id' },
      { key: 'event', label: 'Event', kind: 'select', options: DOMAIN_EVENTS, required: true },
      { key: 'timeout', label: 'Timeout', kind: 'expr', expected: [T.duration], placeholder: 'days(3)' },
    ],
    outputs: () => ['next', 'timeout'],
    defaultOutput: 'next',
    errorEdge: false,
    outputType: () => T.object({ event: { type: T.nullable(T.string) }, payload: { type: T.any } }),
    retry: NO_RETRY,
    external: false,
    wait: true,
  },
  approval: {
    type: 'approval',
    label: 'Approval',
    category: 'human',
    icon: 'user-check',
    description: 'Ask a person to approve or reject.',
    fields: [
      {
        key: 'assignees',
        label: 'Approvers',
        kind: 'expr',
        required: true,
        expected: recipients,
        placeholder: "role('manager')",
      },
      { key: 'title', label: 'Title', kind: 'template', required: true },
      { key: 'details', label: 'Details', kind: 'template' },
      { key: 'timeout', label: 'Timeout', kind: 'expr', expected: [T.duration], placeholder: 'days(2)' },
    ],
    outputs: () => ['approved', 'rejected', 'timeout'],
    defaultOutput: null,
    errorEdge: false,
    outputType: () =>
      T.object({
        decision: { type: T.string },
        decidedBy: { type: T.nullable(T.user) },
        comment: { type: T.nullable(T.string) },
      }),
    retry: NO_RETRY,
    external: false,
    wait: true,
  },
  for_each: {
    type: 'for_each',
    label: 'For each',
    category: 'flow',
    icon: 'repeat',
    description: 'Run the connected sub-graph for each item of a list.',
    fields: [
      { key: 'items', label: 'Items', kind: 'expr', required: true, expected: [T.list(T.any)] },
      { key: 'concurrency', label: 'Concurrency', kind: 'number', default: 2 },
    ],
    outputs: () => ['item', 'done'],
    defaultOutput: null,
    errorEdge: false,
    outputType: () => T.object({ count: { type: T.number }, results: { type: T.list(T.any) } }),
    retry: NO_RETRY,
    external: false,
    wait: true,
  },
  ai_step: {
    type: 'ai_step',
    label: 'AI step',
    category: 'integration',
    icon: 'sparkles',
    description: 'Classify or summarize text with a pluggable model provider.',
    fields: [
      {
        key: 'task',
        label: 'Task',
        kind: 'select',
        options: ['classify', 'summarize'],
        required: true,
        default: 'classify',
      },
      { key: 'input', label: 'Input', kind: 'template', required: true },
      { key: 'labels', label: 'Labels (classify)', kind: 'string_list' },
    ],
    outputs: () => ['next', 'error'],
    defaultOutput: 'next',
    errorEdge: true,
    outputType: () =>
      T.object({
        label: { type: T.nullable(T.string) },
        summary: { type: T.nullable(T.string) },
        confidence: { type: T.number },
      }),
    retry: EXTERNAL_RETRY,
    external: true,
    wait: false,
  },
  end: {
    type: 'end',
    label: 'End',
    category: 'flow',
    icon: 'circle-stop',
    description: 'End this branch.',
    fields: [],
    outputs: () => [],
    defaultOutput: null,
    errorEdge: false,
    outputType: () => T.object({}),
    retry: NO_RETRY,
    external: false,
    wait: false,
  },
};

export function nodeSpec(type: NodeType): NodeSpec {
  return NODE_REGISTRY[type];
}

export function edgeOutcome(node: Pick<WorkflowNode, 'type'> | null, label: string | undefined): string {
  if (label !== undefined && label !== '') return label;
  if (node === null) return 'next';
  return NODE_REGISTRY[node.type].defaultOutput ?? 'next';
}

export function retryPolicyFor(node: WorkflowNode): RetryPolicy {
  const base = NODE_REGISTRY[node.type].retry;
  return { ...base, ...(node.retry ?? {}) } as RetryPolicy;
}
