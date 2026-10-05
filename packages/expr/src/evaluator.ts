import { EvalError, ExprError, MAX_DEPTH, isForbidden, resolveLimits } from './errors';
import { lookupFunction } from './functions';
import type { Runtime } from './functions';
import { arithmetic, compareOrder, kindOf, valuesEqual } from './ops';
import { countNodes, parse, parseTemplate } from './parser';
import type { EvalEnv, Limits, Node, ParsedTemplate, Span } from './types';
import { Duration, Money, formatValue, isPlainObject, ownValue } from './values';

interface State {
  env: EvalEnv;
  limits: Limits;
  now: () => Date;
}

function safeValue(v: unknown, span: Span): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'function')
    throw new EvalError('invalid_value', 'Functions are not allowed in the expression context', span);
  if (typeof v === 'symbol')
    throw new EvalError('invalid_value', 'Symbols are not allowed in the expression context', span);
  if (typeof v === 'bigint') return Number(v);
  return v;
}

function readVar(env: EvalEnv, name: string, span: Span): unknown {
  if (isForbidden(name)) throw new EvalError('forbidden_access', `Access to '${name}' is not allowed`, span);
  const vars: unknown = env.vars;
  if (typeof vars !== 'object' || vars === null)
    throw new EvalError('unknown_identifier', `Unknown identifier '${name}'`, span);
  const desc = Object.getOwnPropertyDescriptor(vars, name);
  if (desc === undefined) throw new EvalError('unknown_identifier', `Unknown identifier '${name}'`, span);
  if (!('value' in desc)) throw new EvalError('invalid_value', `Variable '${name}' is an accessor`, span);
  return safeValue(desc.value, span);
}

function readField(obj: unknown, key: string, span: Span): unknown {
  if (isForbidden(key)) throw new EvalError('forbidden_access', `Access to '${key}' is not allowed`, span);
  if (!isPlainObject(obj)) throw new EvalError('type_error', `Cannot read field '${key}' of ${kindOf(obj)}`, span);
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined || !desc.enumerable) return null;
  if (!('value' in desc)) throw new EvalError('invalid_value', `Field '${key}' is an accessor`, span);
  return safeValue(desc.value, span);
}

function truthy(v: unknown, what: string, span: Span): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  throw new EvalError('type_error', `${what} requires a bool, got ${kindOf(v)}`, span);
}

function ev(n: Node, s: State, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new EvalError('too_deep', 'Expression is nested too deeply', n.span);
  const d = depth + 1;
  switch (n.type) {
    case 'number':
      return n.value;
    case 'string':
      return n.value;
    case 'bool':
      return n.value;
    case 'null':
      return null;
    case 'ident':
      return readVar(s.env, n.name, n.span);
    case 'list': {
      if (n.items.length > s.limits.maxListLength) {
        throw new EvalError('list_too_long', `List literal has more than ${s.limits.maxListLength} items`, n.span);
      }
      return Object.freeze(n.items.map((item) => ev(item, s, d)));
    }
    case 'member': {
      const obj = ev(n.object, s, d);
      if (isForbidden(n.property))
        throw new EvalError('forbidden_access', `Access to '${n.property}' is not allowed`, n.span);
      if (obj === null || obj === undefined) {
        if (n.optional) return null;
        throw new EvalError('null_access', `Cannot read field '${n.property}' of null`, n.span);
      }
      return readField(obj, n.property, n.span);
    }
    case 'index': {
      const obj = ev(n.object, s, d);
      const idx = ev(n.index, s, d);
      if (typeof idx === 'string' && isForbidden(idx)) {
        throw new EvalError('forbidden_access', `Access to '${idx}' is not allowed`, n.index.span);
      }
      if (obj === null || obj === undefined) throw new EvalError('null_access', 'Cannot index null', n.span);
      if (Array.isArray(obj)) {
        if (idx === null) return null;
        if (typeof idx !== 'number')
          throw new EvalError('type_error', `List index must be a number, got ${kindOf(idx)}`, n.index.span);
        if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) return null;
        return safeValue(ownValue(obj, String(idx)), n.span);
      }
      if (isPlainObject(obj)) {
        if (idx === null) return null;
        if (typeof idx !== 'string')
          throw new EvalError('type_error', `Object key must be a string, got ${kindOf(idx)}`, n.index.span);
        return readField(obj, idx, n.span);
      }
      throw new EvalError('type_error', `Cannot index ${kindOf(obj)}`, n.span);
    }
    case 'call':
      return call(n, s, d);
    case 'unary': {
      const v = ev(n.operand, s, d);
      if (n.op === 'not') return !truthy(v, "Operator 'not'", n.span);
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return -v;
      if (v instanceof Duration) return new Duration(-v.ms);
      if (v instanceof Money) return new Money(-v.cents, v.currency);
      throw new EvalError('type_error', `Operator '-' cannot be applied to ${kindOf(v)}`, n.span);
    }
    case 'binary':
      return binary(n, s, d);
    case 'ternary':
      return truthy(ev(n.test, s, d), 'Conditional test', n.test.span) ? ev(n.consequent, s, d) : ev(n.alternate, s, d);
  }
}

function binary(n: Extract<Node, { type: 'binary' }>, s: State, d: number): unknown {
  if (n.op === 'and') {
    if (!truthy(ev(n.left, s, d), "Operator 'and'", n.left.span)) return false;
    return truthy(ev(n.right, s, d), "Operator 'and'", n.right.span);
  }
  if (n.op === 'or') {
    if (truthy(ev(n.left, s, d), "Operator 'or'", n.left.span)) return true;
    return truthy(ev(n.right, s, d), "Operator 'or'", n.right.span);
  }
  const l = ev(n.left, s, d);
  const r = ev(n.right, s, d);
  switch (n.op) {
    case '==':
      return valuesEqual(l, r, n.span);
    case '!=':
      return !valuesEqual(l, r, n.span);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = compareOrder(l, r, n.span);
      if (c === null) return false;
      if (n.op === '<') return c < 0;
      if (n.op === '<=') return c <= 0;
      if (n.op === '>') return c > 0;
      return c >= 0;
    }
    case 'in':
      if (r === null || r === undefined) return false;
      if (Array.isArray(r)) return r.some((item: unknown) => valuesEqual(l, item, n.span));
      if (typeof r === 'string') {
        if (l === null || l === undefined) return false;
        if (typeof l !== 'string') throw new EvalError('type_error', `Cannot search a string for ${kindOf(l)}`, n.span);
        return r.includes(l);
      }
      throw new EvalError('type_error', `Right side of 'in' must be a list or string, got ${kindOf(r)}`, n.span);
    default:
      return arithmetic(n.op, l, r, n.span, s.limits.maxStringLength);
  }
}

function call(n: Extract<Node, { type: 'call' }>, s: State, d: number): unknown {
  const spec = lookupFunction(n.callee);
  if (spec === undefined) throw new EvalError('unknown_function', `Unknown function '${n.callee}'`, n.span);
  if (n.args.length < spec.min || n.args.length > spec.max) {
    throw new EvalError('arity', `${spec.name}() got ${n.args.length} arguments`, n.span);
  }
  if (spec.name === 'coalesce') {
    for (const arg of n.args) {
      const v = ev(arg, s, d);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  const args = n.args.map((a) => ev(a, s, d));
  if (spec.nullProp && args.some((a) => a === null || a === undefined)) return null;
  const rt: Runtime = { now: s.now, host: s.env.host, maxString: s.limits.maxStringLength, span: n.span };
  try {
    return spec.run(args, rt);
  } catch (e) {
    if (e instanceof EvalError && e.span.start === 0 && e.span.end === 0)
      throw new EvalError(e.code, e.message, n.span);
    throw e;
  }
}

function guard<R>(f: () => R): R {
  try {
    return f();
  } catch (e) {
    if (e instanceof ExprError) throw e;
    if (e instanceof RangeError && /call stack/i.test(e.message))
      throw new EvalError('too_deep', 'Expression is nested too deeply');
    throw new EvalError('internal_error', e instanceof Error ? e.message : 'Evaluation failed');
  }
}

export function evaluate(ast: Node, env: EvalEnv): unknown {
  return guard(() => {
    const limits = resolveLimits(env.limits);
    if (countNodes(ast) > limits.maxAstNodes) {
      throw new EvalError('too_many_nodes', `Expression has more than ${limits.maxAstNodes} nodes`, ast.span);
    }
    const nowFn = env.now ?? ((): Date => new Date());
    return ev(ast, { env, limits, now: nowFn }, 0);
  });
}

function firstError(diags: { severity: string; code: string; message: string; span: Span }[]): ExprError | null {
  const d = diags.find((x) => x.severity === 'error');
  return d === undefined ? null : new ExprError(d.code, d.message, d.span);
}

export function evaluateExpression(src: string, env: EvalEnv): unknown {
  const parsed = parse(src, env.limits);
  const err = firstError(parsed.diagnostics);
  if (err !== null) throw err;
  if (parsed.ast === null) throw new ExprError('parse_error', 'Parse failed', { start: 0, end: src.length });
  return evaluate(parsed.ast, env);
}

export function renderTemplate(src: string | ParsedTemplate, env: EvalEnv): string {
  const tpl = typeof src === 'string' ? parseTemplate(src, env.limits) : src;
  const err = firstError(tpl.diagnostics);
  if (err !== null) throw err;
  const max = resolveLimits(env.limits).maxStringLength;
  let out = '';
  for (const part of tpl.parts) {
    out += part.kind === 'text' ? part.value : formatValue(evaluate(part.ast, env));
    if (out.length > max)
      throw new EvalError('string_too_long', `Rendered template exceeds ${max} characters`, part.span);
  }
  return out;
}
