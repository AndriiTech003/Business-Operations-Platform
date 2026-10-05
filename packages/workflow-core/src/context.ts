import { T, analyze, type FieldInfo, type Type, type TypeContext } from '@ashamrai/expr';
import { TRIGGER_NODE_ID, type Trigger, type TriggerEntity, type WorkflowDefinition } from '@bop/contracts';
import { entityType, type CustomFieldMap } from './entities';
import { dominators, type Graph } from './graph';
import { NODE_REGISTRY } from './registry';

export interface ContextEnv {
  custom: CustomFieldMap;
}

export function triggerEntity(trigger: Trigger): TriggerEntity | null {
  if (trigger.type === 'record_event' || trigger.type === 'record_condition') return trigger.entity;
  if (trigger.type === 'manual') return trigger.entity ?? null;
  return null;
}

export function jsonSchemaToType(schema: unknown, depth = 0): Type {
  if (depth > 6 || schema === null || typeof schema !== 'object') return T.any;
  const s = schema as Record<string, unknown>;
  const type = s['type'];
  switch (type) {
    case 'string':
      return s['format'] === 'date-time' || s['format'] === 'date' ? T.string : T.string;
    case 'number':
    case 'integer':
      return T.number;
    case 'boolean':
      return T.bool;
    case 'array':
      return T.list(jsonSchemaToType(s['items'], depth + 1));
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s['required']) ? (s['required'] as string[]) : []);
      const fields: Record<string, FieldInfo> = {};
      for (const [k, v] of Object.entries(props)) {
        const t = jsonSchemaToType(v, depth + 1);
        fields[k] = { type: required.has(k) ? t : T.nullable(t) };
      }
      return T.object(fields, 'payload');
    }
    default:
      return T.any;
  }
}

export function triggerVars(def: Pick<WorkflowDefinition, 'trigger'>, env: ContextEnv): Record<string, Type> {
  const trigger = def.trigger;
  const vars: Record<string, Type> = {
    trigger: T.object(
      {
        type: { type: T.string },
        event: { type: T.nullable(T.string) },
        firedAt: { type: T.date },
        actorType: { type: T.nullable(T.string) },
      },
      'trigger',
    ),
    run: T.object(
      { id: { type: T.string }, number: { type: T.number }, isTest: { type: T.bool }, startedAt: { type: T.date } },
      'run',
    ),
    tenant: T.object({ id: { type: T.string }, name: { type: T.string }, slug: { type: T.string } }, 'tenant'),
  };
  const entity = triggerEntity(trigger);
  if (entity !== null) vars[entity] = entityType(entity, env.custom);
  if (trigger.type === 'webhook')
    vars['payload'] = trigger.schema === undefined ? T.any : jsonSchemaToType(trigger.schema);
  if (trigger.type === 'manual') {
    const fields: Record<string, FieldInfo> = {};
    for (const input of trigger.inputs ?? []) {
      const base =
        input.type === 'number' ? T.number : input.type === 'bool' ? T.bool : input.type === 'date' ? T.date : T.string;
      fields[input.key] = { type: input.required ? base : T.nullable(base), label: input.label };
    }
    vars['input'] = T.object(fields, 'input');
  }
  return vars;
}

export function nodeOutputType(def: WorkflowDefinition, graph: Graph, nodeId: string, env: ContextEnv): Type {
  const node = graph.nodes.get(nodeId);
  if (node === undefined) return T.any;
  const spec = NODE_REGISTRY[node.type];
  const base = spec.outputType(node.config, { custom: env.custom });
  if (!spec.errorEdge || base.kind !== 'object') return base;
  return T.object(
    {
      ...base.fields,
      error: { type: T.nullable(T.string), label: 'Error message (error edge)' },
      code: { type: T.nullable(T.string) },
    },
    base.name,
  );
}

function elementType(t: Type): Type {
  if (t.kind === 'list') return t.of;
  if (t.kind === 'nullable') return elementType(t.of);
  return T.any;
}

export function nodeTypeContext(def: WorkflowDefinition, graph: Graph, nodeId: string, env: ContextEnv): TypeContext {
  const vars = triggerVars(def, env);
  const dom = dominators(graph).get(nodeId) ?? new Set<string>();
  const scope = graph.bodyOf.get(nodeId) ?? null;
  const steps: Record<string, FieldInfo> = {};
  for (const id of dom) {
    if (id === nodeId || id === TRIGGER_NODE_ID) continue;
    const owner = graph.bodyOf.get(id) ?? null;
    if (owner !== null && owner !== scope) continue;
    steps[id] = {
      type: T.object(
        { output: { type: nodeOutputType(def, graph, id, env) }, status: { type: T.string } },
        `steps.${id}`,
      ),
    };
  }
  vars['steps'] = T.object(steps, 'steps');
  if (scope !== null) {
    const loop = graph.nodes.get(scope);
    const itemsSrc = typeof loop?.config['items'] === 'string' ? (loop.config['items'] as string) : '';
    const loopCtx = nodeTypeContext(def, graph, scope, env);
    const result = itemsSrc === '' ? null : analyze(itemsSrc, loopCtx);
    vars['item'] = result === null ? T.any : elementType(result.type);
    vars['index'] = T.number;
  }
  return { vars, allowSecret: false };
}
