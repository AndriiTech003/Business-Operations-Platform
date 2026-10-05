import {
  T,
  analyze,
  compileToSql,
  isAssignable,
  typeToString,
  type AnalyzeResult,
  type Diagnostic,
  type Type,
  type TypeContext,
} from '@ashamrai/expr';
import {
  TRIGGER_NODE_ID,
  workflowDefinitionSchema,
  type TriggerEntity,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@bop/contracts';
import { ENTITY_TABLES, UPDATABLE_FIELDS, sqlFieldResolver, type CustomFieldMap } from './entities';
import { buildGraph, findCycle, reachable, type Graph } from './graph';
import { nodeTypeContext, triggerEntity, triggerVars } from './context';
import { NODE_REGISTRY, edgeOutcome, type ConfigField } from './registry';

export interface ValidationEnv {
  custom: CustomFieldMap;
  emailTemplates?: readonly string[];
  secrets?: readonly string[];
  now?: Date;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  definition: WorkflowDefinition | null;
}

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  return parts.every((p) => CRON_FIELD.test(p) || /^[A-Za-z]{3}(-[A-Za-z]{3})?$/.test(p));
}

function issue(
  nodeId: string | null,
  field: string | null,
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): ValidationIssue {
  return { nodeId, field, code, message, severity };
}

function fromDiagnostic(nodeId: string | null, field: string, d: Diagnostic): ValidationIssue {
  return {
    nodeId,
    field,
    code: d.code,
    message: d.message,
    severity: d.severity,
    span: d.span,
    start: d.start,
    end: d.end,
  };
}

export function assignableToAny(type: Type, expected: readonly Type[]): boolean {
  if (type.kind === 'any') return true;
  return expected.some((e) => e.kind === 'any' || isAssignable(type, e));
}

function checkExpr(
  out: ValidationIssue[],
  nodeId: string | null,
  field: string,
  src: string,
  ctx: TypeContext,
  expected: readonly Type[] | undefined,
  template: boolean,
): AnalyzeResult {
  const result = analyze(src, ctx, { template });
  for (const d of result.diagnostics) out.push(fromDiagnostic(nodeId, field, d));
  const hasError = result.diagnostics.some((d) => d.severity === 'error');
  if (
    !hasError &&
    !template &&
    expected !== undefined &&
    expected.length > 0 &&
    !assignableToAny(result.type, expected)
  ) {
    out.push({
      nodeId,
      field,
      code: 'type_mismatch',
      message: `Expected ${expected.map(typeToString).join(' | ')}, got ${typeToString(result.type)}`,
      severity: 'error',
      span: { start: 0, end: src.length },
      start: { line: 1, col: 1 },
      end: { line: 1, col: src.length + 1 },
    });
  }
  return result;
}

export function recordEntityOf(type: Type): TriggerEntity | null {
  const t = type.kind === 'nullable' ? type.of : type;
  if (t.kind === 'object' && t.name !== undefined && t.name in ENTITY_TABLES) return t.name as TriggerEntity;
  return null;
}

function validateField(
  out: ValidationIssue[],
  node: WorkflowNode,
  field: ConfigField,
  ctx: TypeContext,
  env: ValidationEnv,
): void {
  const value = node.config[field.key];
  const missing = value === undefined || value === null || value === '';
  if (missing) {
    if (field.required) out.push(issue(node.id, field.key, 'required', `${field.label} is required`));
    return;
  }
  const fieldCtx: TypeContext = { ...ctx, allowSecret: field.allowSecret === true };
  switch (field.kind) {
    case 'expr':
      if (typeof value !== 'string')
        out.push(issue(node.id, field.key, 'invalid', `${field.label} must be an expression`));
      else checkExpr(out, node.id, field.key, value, fieldCtx, field.expected, false);
      return;
    case 'template':
      if (typeof value !== 'string') out.push(issue(node.id, field.key, 'invalid', `${field.label} must be text`));
      else checkExpr(out, node.id, field.key, value, fieldCtx, undefined, true);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        out.push(issue(node.id, field.key, 'invalid', `${field.label} must be a number`));
      return;
    case 'bool':
      if (typeof value !== 'boolean')
        out.push(issue(node.id, field.key, 'invalid', `${field.label} must be true or false`));
      return;
    case 'select':
    case 'string':
      if (typeof value !== 'string' || (field.options !== undefined && !field.options.includes(value))) {
        out.push(issue(node.id, field.key, 'invalid', `${field.label} has an unsupported value`));
      }
      return;
    case 'email_template':
      if (typeof value !== 'string') out.push(issue(node.id, field.key, 'invalid', 'Template must be a key'));
      else if (env.emailTemplates !== undefined && !env.emailTemplates.includes(value)) {
        out.push(issue(node.id, field.key, 'unknown_template', `Email template '${value}' does not exist`));
      }
      return;
    case 'string_list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
        out.push(issue(node.id, field.key, 'invalid', `${field.label} must be a list of strings`));
      return;
    case 'header_map':
      if (typeof value !== 'object' || Array.isArray(value)) {
        out.push(issue(node.id, field.key, 'invalid', `${field.label} must be an object`));
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== 'string')
          out.push(issue(node.id, `${field.key}.${k}`, 'invalid', 'Header value must be text'));
        else checkExpr(out, node.id, `${field.key}.${k}`, v, fieldCtx, undefined, true);
      }
      return;
    case 'cases': {
      if (!Array.isArray(value) || value.length === 0) {
        out.push(issue(node.id, field.key, 'invalid', 'At least one case is required'));
        return;
      }
      const names = new Set<string>();
      value.forEach((c: unknown, i: number) => {
        const item = (c ?? {}) as { name?: unknown; when?: unknown };
        if (typeof item.name !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(item.name)) {
          out.push(
            issue(node.id, `${field.key}.${i}.name`, 'invalid', 'Case name must be 1-40 letters, digits, - or _'),
          );
        } else if (names.has(item.name))
          out.push(issue(node.id, `${field.key}.${i}.name`, 'duplicate', `Duplicate case '${item.name}'`));
        else names.add(item.name);
        if (typeof item.when !== 'string')
          out.push(issue(node.id, `${field.key}.${i}.when`, 'required', 'Case condition is required'));
        else checkExpr(out, node.id, `${field.key}.${i}.when`, item.when, fieldCtx, field.expected, false);
      });
      return;
    }
    case 'field_map':
      return;
  }
}

function validateUpdateRecord(out: ValidationIssue[], node: WorkflowNode, ctx: TypeContext, env: ValidationEnv): void {
  const recordSrc = node.config['record'];
  const fields = node.config['fields'];
  if (typeof recordSrc !== 'string' || typeof fields !== 'object' || fields === null || Array.isArray(fields)) return;
  const record = analyze(recordSrc, ctx);
  const entity = recordEntityOf(record.type);
  if (entity === null) {
    if (!record.diagnostics.some((d) => d.severity === 'error')) {
      out.push(
        issue(
          node.id,
          'record',
          'type_mismatch',
          `Record must be a company, contact, deal, invoice or task, got ${typeToString(record.type)}`,
        ),
      );
    }
    return;
  }
  const allowed = UPDATABLE_FIELDS[entity];
  const custom = env.custom[entity] ?? [];
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) out.push(issue(node.id, 'fields', 'required', 'At least one field is required'));
  for (const [key, src] of entries) {
    let expected: Type | undefined = allowed[key];
    if (key.startsWith('custom.')) {
      const def = custom.find((d) => `custom.${d.key}` === key);
      if (def !== undefined) {
        expected =
          def.type === 'number'
            ? T.number
            : def.type === 'money'
              ? T.money
              : def.type === 'date'
                ? T.date
                : def.type === 'multi_select'
                  ? T.list(T.string)
                  : T.string;
      }
    }
    if (expected === undefined) {
      out.push(issue(node.id, `fields.${key}`, 'unknown_field', `Field '${key}' cannot be updated on ${entity}`));
      continue;
    }
    if (typeof src !== 'string') {
      out.push(issue(node.id, `fields.${key}`, 'invalid', 'Value must be an expression'));
      continue;
    }
    const accepted =
      expected.kind === 'money' ? [T.money, T.number, T.nullable(T.money)] : [expected, T.nullable(expected), T.null];
    checkExpr(out, node.id, `fields.${key}`, src, ctx, accepted, false);
  }
}

function validateGraph(out: ValidationIssue[], def: WorkflowDefinition, graph: Graph): void {
  const ids = new Set<string>();
  for (const node of def.nodes) {
    if (node.id === TRIGGER_NODE_ID) out.push(issue(node.id, null, 'reserved_id', `'${TRIGGER_NODE_ID}' is reserved`));
    if (ids.has(node.id)) out.push(issue(node.id, null, 'duplicate_id', `Duplicate node id '${node.id}'`));
    ids.add(node.id);
  }
  const seen = new Set<string>();
  for (const edge of def.edges) {
    if (edge.from !== TRIGGER_NODE_ID && !graph.nodes.has(edge.from))
      out.push(issue(null, null, 'unknown_node', `Edge from unknown node '${edge.from}'`));
    if (!graph.nodes.has(edge.to)) out.push(issue(null, null, 'unknown_node', `Edge to unknown node '${edge.to}'`));
    const key = `${edge.from}->${edge.to}:${edge.label ?? ''}`;
    if (seen.has(key))
      out.push(
        issue(
          edge.from === TRIGGER_NODE_ID ? null : edge.from,
          null,
          'duplicate_edge',
          `Duplicate edge ${edge.from} → ${edge.to}`,
        ),
      );
    seen.add(key);
    if (edge.from === TRIGGER_NODE_ID) continue;
    const source = graph.nodes.get(edge.from);
    if (source === undefined) continue;
    const spec = NODE_REGISTRY[source.type];
    const outcome = edgeOutcome(source, edge.label);
    const allowed = spec.outputs(source.config);
    if (edge.label === undefined && spec.defaultOutput === null && allowed.length > 0) {
      out.push(
        issue(source.id, null, 'label_required', `Edges from ${spec.label} need a label: ${allowed.join(', ')}`),
      );
    } else if (!allowed.includes(outcome)) {
      out.push(
        issue(
          source.id,
          null,
          'invalid_label',
          `'${outcome}' is not an output of ${spec.label} (allowed: ${allowed.join(', ') || 'none'})`,
        ),
      );
    }
  }
  const fromTrigger = graph.out.get(TRIGGER_NODE_ID) ?? [];
  if (fromTrigger.length !== 1)
    out.push(issue(null, null, 'trigger_edges', 'The trigger must connect to exactly one node'));
  if (def.nodes.length === 0) out.push(issue(null, null, 'empty', 'Add at least one node'));
  const reach = reachable(graph);
  for (const node of def.nodes)
    if (!reach.has(node.id))
      out.push(issue(node.id, null, 'unreachable', `Node '${node.id}' is not reachable from the trigger`));
  const cycle = findCycle(graph);
  if (cycle !== null) out.push(issue(cycle[0] ?? null, null, 'cycle', `Cycle detected: ${cycle.join(' → ')}`));
  for (const node of def.nodes) {
    const outgoing = graph.out.get(node.id) ?? [];
    if (node.type === 'condition' && outgoing.length === 0)
      out.push(issue(node.id, null, 'no_branch', 'A condition needs at least one branch'));
    if (node.type === 'end' && outgoing.length > 0)
      out.push(issue(node.id, null, 'end_outgoing', 'End nodes cannot have outgoing edges'));
    if (node.type === 'for_each') {
      if (!outgoing.some((e) => e.label === 'item'))
        out.push(issue(node.id, null, 'no_body', "For each needs an 'item' edge to its body"));
      const body = graph.bodies.get(node.id) ?? new Set<string>();
      for (const id of body) {
        const inner = graph.nodes.get(id);
        if (inner?.type === 'for_each') out.push(issue(id, null, 'nested_loop', 'Nested for each is not supported'));
        if (graph.bodyOf.get(id) !== node.id)
          out.push(issue(id, null, 'shared_body', 'A node cannot belong to two loop bodies'));
        for (const e of graph.out.get(id) ?? []) {
          if (!body.has(e.to))
            out.push(issue(id, null, 'body_escape', `Loop body node '${id}' cannot connect outside the loop`));
        }
        for (const e of graph.in.get(id) ?? []) {
          if (e.from !== node.id && !body.has(e.from))
            out.push(issue(id, null, 'body_entry', `Loop body node '${id}' can only be entered from '${node.id}'`));
        }
      }
    }
  }
}

function validateTrigger(out: ValidationIssue[], def: WorkflowDefinition, env: ValidationEnv): void {
  const trigger = def.trigger;
  const ctx: TypeContext = { vars: triggerVars(def, env) };
  if (trigger.type === 'record_event' && trigger.filter !== undefined && trigger.filter.trim() !== '') {
    checkExpr(out, null, 'trigger.filter', trigger.filter, ctx, [T.bool, T.nullable(T.bool)], false);
    if (!trigger.event.startsWith(`${trigger.entity}.`))
      out.push(issue(null, 'trigger.event', 'invalid', `Event ${trigger.event} is not an event of ${trigger.entity}`));
  }
  if (
    trigger.type === 'record_event' &&
    (trigger.filter === undefined || trigger.filter.trim() === '') &&
    !trigger.event.startsWith(`${trigger.entity}.`)
  ) {
    out.push(issue(null, 'trigger.event', 'invalid', `Event ${trigger.event} is not an event of ${trigger.entity}`));
  }
  if (trigger.type === 'record_condition') {
    const result = checkExpr(
      out,
      null,
      'trigger.condition',
      trigger.condition,
      ctx,
      [T.bool, T.nullable(T.bool)],
      false,
    );
    if (result.ast !== null && !result.diagnostics.some((d) => d.severity === 'error')) {
      const sql = compileToSql(result.ast, {
        resolveField: sqlFieldResolver(trigger.entity, env.custom),
        now: env.now ?? new Date(),
      });
      if (!sql.ok) for (const d of sql.diagnostics) out.push(fromDiagnostic(null, 'trigger.condition', d));
    }
    if (trigger.dedupe !== undefined && trigger.dedupe.trim() !== '')
      checkExpr(out, null, 'trigger.dedupe', trigger.dedupe, ctx, [T.string, T.number], false);
  }
  if (trigger.type === 'schedule' && !isValidCron(trigger.cron))
    out.push(issue(null, 'trigger.cron', 'invalid_cron', `Invalid cron expression '${trigger.cron}'`));
  if (trigger.type === 'webhook' && trigger.schema !== undefined && trigger.schema['type'] !== 'object') {
    out.push(issue(null, 'trigger.schema', 'invalid_schema', "Webhook JSON Schema must have type 'object'"));
  }
}

export function validateDefinition(input: unknown, env: ValidationEnv): ValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      definition: null,
      issues: parsed.error.issues.map((i) => issue(null, i.path.join('.'), 'schema', i.message)),
    };
  }
  const def = parsed.data;
  const out: ValidationIssue[] = [];
  const graph = buildGraph(def);
  validateGraph(out, def, graph);
  validateTrigger(out, def, env);
  const structural = out.some((i) => i.code === 'cycle' || i.code === 'unknown_node');
  if (!structural) {
    for (const node of def.nodes) {
      const ctx = nodeTypeContext(def, graph, node.id, env);
      for (const field of NODE_REGISTRY[node.type].fields) validateField(out, node, field, ctx, env);
      if (node.type === 'update_record') validateUpdateRecord(out, node, ctx, env);
      if (node.type === 'send_email') {
        const hasTemplate = typeof node.config['template'] === 'string' && node.config['template'] !== '';
        const hasInline = typeof node.config['subject'] === 'string' && typeof node.config['body'] === 'string';
        if (!hasTemplate && !hasInline)
          out.push(issue(node.id, 'template', 'required', 'Choose a template or enter subject and body'));
        if (node.config['attachInvoice'] === true && triggerEntity(def.trigger) !== 'invoice') {
          out.push(
            issue(
              node.id,
              'attachInvoice',
              'invalid',
              'Invoice PDF can only be attached when the trigger record is an invoice',
            ),
          );
        }
      }
      if (node.type === 'for_each') {
        const c = node.config['concurrency'];
        if (c !== undefined && (typeof c !== 'number' || c < 1 || c > 10))
          out.push(issue(node.id, 'concurrency', 'invalid', 'Concurrency must be between 1 and 10'));
      }
    }
  }
  return { ok: !out.some((i) => i.severity === 'error'), issues: out, definition: def };
}
