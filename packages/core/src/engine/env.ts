import {
  collectHostCalls,
  evaluate,
  hydrate,
  parse,
  parseTemplate,
  toJSON,
  formatValue,
  T,
  type EvalEnv,
  type Node,
  type ParsedTemplate,
  type UserValue,
} from '@ashamrai/expr';
import type { WorkflowNode } from '@bop/contracts';
import { NODE_REGISTRY, nodeTypeContext, type CustomFieldMap } from '@bop/workflow-core';
import type { StepRun, WorkflowRun } from '../generated/prisma/client';
import type { Member } from '../services/directory';
import type { LoadedDefinition } from './definitions';
import { StepError } from './errors';

const exprCache = new Map<string, Node>();
const templateCache = new Map<string, ParsedTemplate>();

export function compiledExpr(src: string): Node {
  let ast = exprCache.get(src);
  if (ast === undefined) {
    const result = parse(src);
    const err = result.diagnostics.find((d) => d.severity === 'error');
    if (result.ast === null || err !== undefined)
      throw new StepError(`Expression error: ${err?.message ?? 'invalid'}`, false, 'expression_error');
    ast = result.ast;
    exprCache.set(src, ast);
    if (exprCache.size > 5000) exprCache.delete(exprCache.keys().next().value as string);
  }
  return ast;
}

export function compiledTemplate(src: string): ParsedTemplate {
  let t = templateCache.get(src);
  if (t === undefined) {
    t = parseTemplate(src);
    const err = t.diagnostics.find((d) => d.severity === 'error');
    if (err !== undefined) throw new StepError(`Template error: ${err.message}`, false, 'expression_error');
    templateCache.set(src, t);
    if (templateCache.size > 5000) templateCache.delete(templateCache.keys().next().value as string);
  }
  return t;
}

export interface RunContextJson {
  steps?: Record<string, { output: unknown; status: string; outcome?: string | null }>;
  loops?: Record<string, { items: unknown[]; next: number; done: number; results: unknown[]; concurrency: number }>;
  iterations?: Record<
    string,
    Record<string, Record<string, { output: unknown; status: string; outcome?: string | null }>>
  >;
}

export interface TriggerPayloadJson {
  type: string;
  entity?: string;
  recordId?: string;
  record?: Record<string, unknown> | null;
  event?: { id: string; type: string; actorType?: string; payload?: unknown } | null;
  input?: Record<string, unknown>;
  payload?: unknown;
  firedAt: string;
}

export interface EnvSources {
  custom: CustomFieldMap;
  members: Member[];
  secrets: Map<string, string>;
  tenant: { id: string; name: string; slug: string };
}

export function secretNamesFor(node: WorkflowNode): string[] {
  const names = new Set<string>();
  for (const field of NODE_REGISTRY[node.type].fields) {
    if (field.allowSecret !== true) continue;
    const value = node.config[field.key];
    const sources =
      typeof value === 'string'
        ? [value]
        : value !== null && typeof value === 'object'
          ? Object.values(value as Record<string, unknown>).filter((v): v is string => typeof v === 'string')
          : [];
    for (const src of sources) for (const n of collectHostCalls(compiledTemplate(src)).secrets) names.add(n);
  }
  return [...names];
}

export function buildEnv(
  run: WorkflowRun,
  step: StepRun,
  loaded: LoadedDefinition,
  sources: EnvSources,
  now: () => Date = () => new Date(),
): EvalEnv {
  const { definition, graph } = loaded;
  const typeCtx = nodeTypeContext(definition, graph, step.nodeId, { custom: sources.custom });
  const payload = run.triggerPayload as unknown as TriggerPayloadJson;
  const context = (run.context ?? {}) as RunContextJson;
  const raw: Record<string, unknown> = {
    trigger: {
      type: payload.type,
      event: payload.event?.type ?? null,
      firedAt: payload.firedAt,
      actorType: payload.event?.actorType ?? null,
    },
    run: { id: run.id, number: run.number, isTest: run.isTest, startedAt: run.startedAt.toISOString() },
    tenant: sources.tenant,
  };
  if (payload.entity !== undefined) raw[payload.entity] = payload.record ?? null;
  if (payload.input !== undefined) raw['input'] = payload.input;
  if (payload.type === 'webhook') raw['payload'] = payload.payload ?? null;
  const scope = graph.bodyOf.get(step.nodeId) ?? null;
  const steps: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(context.steps ?? {})) steps[id] = { output: s.output, status: s.status };
  if (scope !== null) {
    const local = context.iterations?.[scope]?.[String(step.iteration)] ?? {};
    for (const [id, s] of Object.entries(local)) steps[id] = { output: s.output, status: s.status };
    const loop = context.loops?.[scope];
    raw['item'] = loop?.items[step.iteration - 1] ?? null;
    raw['index'] = step.iteration - 1;
  }
  raw['steps'] = steps;
  const vars: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(typeCtx.vars)) vars[name] = hydrate(raw[name] ?? null, type);
  for (const name of Object.keys(raw)) if (!(name in vars)) vars[name] = hydrate(raw[name], T.any);
  const byId = new Map(sources.members.map((m) => [m.id, { id: m.id, name: m.name, email: m.email } as UserValue]));
  const order = ['viewer', 'member', 'manager', 'admin', 'owner'];
  return {
    vars,
    now,
    host: {
      role(name: string) {
        if (name === 'member')
          return sources.members
            .filter((m) => m.role === 'member' || m.role === 'manager')
            .map((m) => byId.get(m.id) as UserValue);
        const min = order.indexOf(name);
        if (min < 0) return [];
        return sources.members.filter((m) => order.indexOf(m.role) >= min).map((m) => byId.get(m.id) as UserValue);
      },
      user(id: string) {
        return byId.get(id) ?? null;
      },
      secret(name: string) {
        const value = sources.secrets.get(name);
        if (value === undefined) throw new StepError(`Secret '${name}' is not defined`, false, 'missing_secret');
        return value;
      },
    },
  };
}

export interface ResolvedInput {
  values: Record<string, unknown>;
  json: Record<string, unknown>;
}

function redact(json: unknown, secrets: Map<string, string>): unknown {
  if (secrets.size === 0) return json;
  let text = JSON.stringify(json);
  for (const [name, value] of secrets)
    if (value.length >= 4) text = text.split(JSON.stringify(value).slice(1, -1)).join(`[secret:${name}]`);
  return JSON.parse(text) as unknown;
}

export function resolveInput(node: WorkflowNode, env: EvalEnv, secrets: Map<string, string>): ResolvedInput {
  const values: Record<string, unknown> = {};
  const evalExpr = (src: string) => evaluate(compiledExpr(src), env);
  const evalTemplate = (src: string) => {
    let out = '';
    for (const part of compiledTemplate(src).parts)
      out += part.kind === 'text' ? part.value : formatValue(evaluate(part.ast, env));
    return out;
  };
  for (const field of NODE_REGISTRY[node.type].fields) {
    const raw = node.config[field.key];
    if (raw === undefined || raw === null || raw === '') {
      values[field.key] = field.default ?? null;
      continue;
    }
    switch (field.kind) {
      case 'expr':
        values[field.key] = evalExpr(String(raw));
        break;
      case 'template':
        values[field.key] = evalTemplate(String(raw));
        break;
      case 'field_map':
        values[field.key] = Object.fromEntries(
          Object.entries(raw as Record<string, string>).map(([k, v]) => [k, evalExpr(v)]),
        );
        break;
      case 'header_map':
        values[field.key] = Object.fromEntries(
          Object.entries(raw as Record<string, string>).map(([k, v]) => [k, evalTemplate(v)]),
        );
        break;
      case 'cases':
        values[field.key] = (raw as Array<{ name: string; when: string }>).map((c) => ({
          name: c.name,
          when: evalExpr(c.when) === true,
        }));
        break;
      default:
        values[field.key] = raw;
    }
  }
  const json = redact(toJSON(values), secrets) as Record<string, unknown>;
  return { values, json };
}
