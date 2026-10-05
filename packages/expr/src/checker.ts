import { didYouMean, isForbidden, makeDiagnostic } from './errors';
import { CheckIssue, FUNCTION_SPECS, lookupFunction } from './functions';
import { parse, parseTemplate } from './parser';
import { T, base, comparable, fieldsOf, isAssignable, isNullish, typeToString, unify } from './typesys';
import type {
  AnalyzeOptions,
  AnalyzeResult,
  CheckResult,
  Diagnostic,
  Node,
  Severity,
  Span,
  Type,
  TypeContext,
} from './types';

const ORDERABLE = ['number', 'string', 'date', 'duration', 'money'];

function arithBase(op: string, a: Type, b: Type): Type | null {
  const ka = a.kind;
  const kb = b.kind;
  switch (op) {
    case '+':
      if (ka === 'number' && kb === 'number') return T.number;
      if (ka === 'string' && kb === 'string') return T.string;
      if ((ka === 'date' && kb === 'duration') || (ka === 'duration' && kb === 'date')) return T.date;
      if (ka === 'duration' && kb === 'duration') return T.duration;
      if (ka === 'money' && kb === 'money') return T.money;
      return null;
    case '-':
      if (ka === 'number' && kb === 'number') return T.number;
      if (ka === 'date' && kb === 'date') return T.duration;
      if (ka === 'date' && kb === 'duration') return T.date;
      if (ka === 'duration' && kb === 'duration') return T.duration;
      if (ka === 'money' && kb === 'money') return T.money;
      return null;
    case '*':
      if (ka === 'number' && kb === 'number') return T.number;
      if ((ka === 'duration' && kb === 'number') || (ka === 'number' && kb === 'duration')) return T.duration;
      if ((ka === 'money' && kb === 'number') || (ka === 'number' && kb === 'money')) return T.money;
      return null;
    case '/':
      if (ka === 'number' && kb === 'number') return T.number;
      if (ka === 'duration' && kb === 'number') return T.duration;
      if (ka === 'money' && kb === 'number') return T.money;
      return null;
    case '%':
      return ka === 'number' && kb === 'number' ? T.number : null;
    default:
      return null;
  }
}

function propertySpan(n: Extract<Node, { type: 'member' }>): Span {
  return { start: Math.max(n.span.start, n.span.end - n.property.length), end: n.span.end };
}

function describePath(n: Node): string {
  if (n.type === 'ident') return n.name;
  if (n.type === 'member') return `${describePath(n.object)}${n.optional ? '?.' : '.'}${n.property}`;
  return 'value';
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly ctx: TypeContext,
    private readonly src: string | undefined,
  ) {}

  private report(code: string, message: string, span: Span, severity: Severity = 'error'): void {
    this.diagnostics.push(makeDiagnostic(code, message, span, this.src, severity));
  }

  private requireBool(t: Type, n: Node, what: string): void {
    const b = base(t);
    if (b.kind === 'bool' || b.kind === 'null' || b.kind === 'any') return;
    this.report('type_mismatch', `${what} requires a bool, got ${typeToString(t)}`, n.span);
  }

  visit(n: Node): Type {
    switch (n.type) {
      case 'number':
        return T.number;
      case 'string':
        return T.string;
      case 'bool':
        return T.bool;
      case 'null':
        return T.null;
      case 'ident':
        return this.ident(n.name, n.span);
      case 'list':
        return this.list(n.items, n.span);
      case 'member':
        return this.member(n);
      case 'index':
        return this.index(n);
      case 'call':
        return this.call(n);
      case 'unary':
        return this.unary(n);
      case 'binary':
        return this.binary(n);
      case 'ternary':
        return this.ternary(n);
    }
  }

  private ident(name: string, span: Span): Type {
    if (isForbidden(name)) {
      this.report('forbidden_identifier', `Identifier '${name}' is not allowed`, span);
      return T.any;
    }
    const vars = this.ctx.vars;
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const t = vars[name];
      if (t !== undefined) return t;
    }
    this.report(
      'unknown_identifier',
      `Unknown identifier '${name}'.${didYouMean(name, Object.keys(vars))}`.replace(/\.$/, ''),
      span,
    );
    return T.any;
  }

  private list(items: Node[], span: Span): Type {
    let elem: Type | null = null;
    let failed = false;
    for (const item of items) {
      const t = this.visit(item);
      if (failed) continue;
      if (elem === null) {
        elem = t;
        continue;
      }
      const u = unify(elem, t);
      if (u === null) {
        this.report(
          'type_mismatch',
          `List items must have compatible types, got ${typeToString(elem)} and ${typeToString(t)}`,
          span,
        );
        failed = true;
      } else elem = u;
    }
    return T.list(failed || elem === null ? T.any : elem);
  }

  private member(n: Extract<Node, { type: 'member' }>): Type {
    const obj = this.visit(n.object);
    if (isForbidden(n.property)) {
      this.report('forbidden_identifier', `Field name '${n.property}' is not allowed`, propertySpan(n));
      return T.any;
    }
    if (obj.kind === 'any') return T.any;
    if (obj.kind === 'null') {
      if (n.optional) return T.null;
      this.report('null_access', `Cannot read field '${n.property}' of null`, n.span);
      return T.any;
    }
    const b = base(obj);
    if (b.kind === 'any') return T.any;
    const fields = fieldsOf(b);
    if (fields === null) {
      this.report('not_an_object', `Type ${typeToString(obj)} has no field '${n.property}'`, n.span);
      return T.any;
    }
    const field = Object.prototype.hasOwnProperty.call(fields, n.property) ? fields[n.property] : undefined;
    if (field === undefined) {
      const msg = `Unknown field '${n.property}' on ${typeToString(b)}.${didYouMean(n.property, Object.keys(fields))}`;
      this.report('unknown_field', msg.replace(/\.$/, ''), propertySpan(n));
      return T.any;
    }
    if (obj.kind === 'nullable') {
      if (!n.optional) {
        this.report(
          'nullable_access',
          `'${describePath(n.object)}' may be null; use '?.' to read '${n.property}' safely`,
          propertySpan(n),
          'warning',
        );
      }
      return T.nullable(field.type);
    }
    return field.type;
  }

  private index(n: Extract<Node, { type: 'index' }>): Type {
    const obj = this.visit(n.object);
    const idx = this.visit(n.index);
    const literal = n.index.type === 'string' ? n.index.value : null;
    if (literal !== null && isForbidden(literal)) {
      this.report('forbidden_access', `Access to '${literal}' is not allowed`, n.index.span);
      return T.any;
    }
    if (obj.kind === 'any') return T.any;
    if (obj.kind === 'null') {
      this.report('null_access', 'Cannot index null', n.span);
      return T.any;
    }
    const wrap = (t: Type): Type => (obj.kind === 'nullable' ? T.nullable(t) : t);
    if (obj.kind === 'nullable') {
      this.report('nullable_access', `'${describePath(n.object)}' may be null`, n.span, 'warning');
    }
    const b = base(obj);
    const ib = base(idx);
    if (b.kind === 'any') return T.any;
    if (b.kind === 'list') {
      if (ib.kind !== 'number' && ib.kind !== 'any' && ib.kind !== 'null') {
        this.report('type_mismatch', `List index must be a number, got ${typeToString(idx)}`, n.index.span);
      }
      return T.nullable(b.of);
    }
    const fields = fieldsOf(b);
    if (fields !== null) {
      if (ib.kind !== 'string' && ib.kind !== 'any' && ib.kind !== 'null') {
        this.report('type_mismatch', `Object key must be a string, got ${typeToString(idx)}`, n.index.span);
        return T.any;
      }
      if (literal === null) return T.any;
      const field = Object.prototype.hasOwnProperty.call(fields, literal) ? fields[literal] : undefined;
      if (field === undefined) {
        const msg = `Unknown field '${literal}' on ${typeToString(b)}.${didYouMean(literal, Object.keys(fields))}`;
        this.report('unknown_field', msg.replace(/\.$/, ''), n.index.span);
        return T.any;
      }
      return wrap(field.type);
    }
    this.report('not_indexable', `Type ${typeToString(obj)} cannot be indexed`, n.span);
    return T.any;
  }

  private call(n: Extract<Node, { type: 'call' }>): Type {
    const args = n.args.map((a) => this.visit(a));
    if (n.callee === '') {
      this.report('not_callable', 'Only whitelisted functions can be called', n.span);
      return T.any;
    }
    const spec = lookupFunction(n.callee);
    if (spec === undefined) {
      const names = FUNCTION_SPECS.map((f) => f.name);
      this.report(
        'unknown_function',
        `Unknown function '${n.callee}'.${didYouMean(n.callee, names)}`.replace(/\.$/, ''),
        n.span,
      );
      return T.any;
    }
    if (n.args.length < spec.min || n.args.length > spec.max) {
      const range =
        spec.min === spec.max
          ? `${spec.min}`
          : spec.max === Infinity
            ? `at least ${spec.min}`
            : `${spec.min}-${spec.max}`;
      this.report(
        'arity',
        `${spec.name}() expects ${range} argument${range === '1' ? '' : 's'}, got ${n.args.length}`,
        n.span,
      );
      return T.any;
    }
    if (spec.name === 'secret' && this.ctx.allowSecret !== true) {
      this.report('secret_not_allowed', 'secret() is not allowed in this field', n.span);
    }
    if (spec.literalArg === true) {
      const arg = n.args[0];
      if (arg !== undefined && arg.type !== 'string') {
        this.report('literal_required', `${spec.name}() requires a string literal argument`, arg.span);
      } else if (arg !== undefined && arg.value === '') {
        this.report('literal_required', `${spec.name}() requires a non-empty name`, arg.span);
      }
    }
    if (spec.name === 'coalesce') return this.coalesce(args, n.span);
    const nullable = spec.nullProp && args.some((a) => isNullish(a));
    const passed = spec.nullProp ? args.map((a) => (a.kind === 'null' ? T.any : base(a))) : args;
    try {
      const result = spec.check(passed);
      return nullable ? T.nullable(result) : result;
    } catch (e) {
      if (!(e instanceof CheckIssue)) throw e;
      const span = e.argIndex >= 0 ? (n.args[e.argIndex]?.span ?? n.span) : n.span;
      this.report(e.code, e.message, span);
      return T.any;
    }
  }

  private coalesce(args: Type[], span: Span): Type {
    let result: Type | null = null;
    for (const a of args) {
      const next: Type | null = result === null ? a : unify(result, a);
      if (next === null) {
        this.report('type_mismatch', `coalesce() arguments must have compatible types`, span);
        return T.any;
      }
      result = next;
    }
    if (result === null) return T.any;
    const definite = args.some((a) => !isNullish(a) && a.kind !== 'any');
    return definite ? base(result) : result;
  }

  private unary(n: Extract<Node, { type: 'unary' }>): Type {
    const t = this.visit(n.operand);
    if (n.op === 'not') {
      this.requireBool(t, n.operand, "Operator 'not'");
      return T.bool;
    }
    const b = base(t);
    if (b.kind === 'any' || t.kind === 'null') return t;
    if (b.kind === 'number' || b.kind === 'duration' || b.kind === 'money') return t;
    this.report('type_mismatch', `Operator '-' cannot be applied to ${typeToString(t)}`, n.span);
    return T.any;
  }

  private binary(n: Extract<Node, { type: 'binary' }>): Type {
    const l = this.visit(n.left);
    const r = this.visit(n.right);
    const op = n.op;
    const mismatch = (detail: string): void => {
      this.report('type_mismatch', `Operator '${op}' ${detail} (${typeToString(l)} and ${typeToString(r)})`, n.span);
    };
    if (op === 'and' || op === 'or') {
      this.requireBool(l, n.left, `Operator '${op}'`);
      this.requireBool(r, n.right, `Operator '${op}'`);
      return T.bool;
    }
    if (op === '==' || op === '!=') {
      if (!comparable(l, r)) mismatch('cannot compare these types');
      return T.bool;
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (l.kind === 'any' || r.kind === 'any' || l.kind === 'null' || r.kind === 'null') return T.bool;
      const bl = base(l);
      const br = base(r);
      if (bl.kind === 'any' || br.kind === 'any') return T.bool;
      const moneyMix = (bl.kind === 'money' && br.kind === 'number') || (bl.kind === 'number' && br.kind === 'money');
      if (!moneyMix && !(bl.kind === br.kind && ORDERABLE.includes(bl.kind))) mismatch('cannot order these types');
      return T.bool;
    }
    if (op === 'in') {
      if (r.kind === 'any' || r.kind === 'null') return T.bool;
      const br = base(r);
      if (br.kind === 'any') return T.bool;
      if (br.kind === 'list') {
        if (!comparable(l, br.of)) mismatch('requires an item compatible with the list');
      } else if (br.kind === 'string') {
        const bl = base(l);
        if (bl.kind !== 'string' && bl.kind !== 'null' && bl.kind !== 'any')
          mismatch('requires a string on the left of a string');
      } else mismatch('requires a list or string on the right');
      return T.bool;
    }
    if (l.kind === 'any' || r.kind === 'any') return T.any;
    if (l.kind === 'null' || r.kind === 'null') return T.null;
    const bl = base(l);
    const br = base(r);
    if (bl.kind === 'any' || br.kind === 'any') return T.any;
    const result = arithBase(op, bl, br);
    if (result === null) {
      mismatch('cannot be applied to these types');
      return T.any;
    }
    return isNullish(l) || isNullish(r) ? T.nullable(result) : result;
  }

  private ternary(n: Extract<Node, { type: 'ternary' }>): Type {
    const t = this.visit(n.test);
    this.requireBool(t, n.test, 'Conditional test');
    const a = this.visit(n.consequent);
    const b = this.visit(n.alternate);
    const u = unify(a, b);
    if (u === null) {
      this.report(
        'type_mismatch',
        `Conditional branches have incompatible types ${typeToString(a)} and ${typeToString(b)}`,
        n.span,
      );
      return T.any;
    }
    return u;
  }
}

export function check(ast: Node, ctx: TypeContext, src?: string): CheckResult {
  const checker = new Checker(ctx, src);
  try {
    const type = checker.visit(ast);
    return { type, diagnostics: checker.diagnostics };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Type check failed';
    return {
      type: T.any,
      diagnostics: [...checker.diagnostics, makeDiagnostic('check_failed', message, ast.span, src)],
    };
  }
}

function accepts(type: Type, expected: Type): boolean {
  if (isAssignable(type, expected)) return true;
  if (expected.kind === 'bool') return type.kind === 'null' || (type.kind === 'nullable' && type.of.kind === 'bool');
  return false;
}

export function analyze(src: string, ctx: TypeContext, opts: AnalyzeOptions = {}): AnalyzeResult {
  const whole = { start: 0, end: src.length };
  const expected = opts.expected;
  if (opts.template === true) {
    const template = parseTemplate(src);
    const diagnostics = [...template.diagnostics];
    for (const part of template.parts) {
      if (part.kind === 'expr') diagnostics.push(...check(part.ast, ctx, src).diagnostics);
    }
    if (expected !== undefined && !accepts(T.string, expected)) {
      diagnostics.push(makeDiagnostic('type_mismatch', `Expected ${typeToString(expected)}, got string`, whole, src));
    }
    return { ast: null, template, type: T.string, diagnostics };
  }
  const parsed = parse(src);
  if (parsed.ast === null) return { ast: null, template: null, type: T.any, diagnostics: parsed.diagnostics };
  const result = check(parsed.ast, ctx, src);
  const diagnostics = [...parsed.diagnostics, ...result.diagnostics];
  if (expected !== undefined && !diagnostics.some((d) => d.severity === 'error') && !accepts(result.type, expected)) {
    diagnostics.push(
      makeDiagnostic(
        'type_mismatch',
        `Expected ${typeToString(expected)}, got ${typeToString(result.type)}`,
        parsed.ast.span,
        src,
      ),
    );
  }
  return { ast: parsed.ast, template: null, type: result.type, diagnostics };
}
