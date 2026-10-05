import { makeDiagnostic } from './errors';
import { base } from './typesys';
import type { Node, SqlCompileOptions, SqlCompileResult } from './types';
import { DAY_MS, HOUR_MS } from './values';

type Kind = 'number' | 'string' | 'bool' | 'date' | 'duration' | 'money' | 'null';

interface Value {
  sql: string;
  kind: Kind;
}

class Unsupported {
  constructor(readonly node: Node) {}
}

const ORDERING = ['<', '<=', '>', '>='];
const BOOL_OPS = ['and', 'or', '==', '!=', '<', '<=', '>', '>=', 'in'];

function fieldPath(n: Node): string[] | null {
  if (n.type === 'ident') return [n.name];
  if (n.type === 'member') {
    const p = fieldPath(n.object);
    return p === null ? null : [...p, n.property];
  }
  if (n.type === 'index' && n.index.type === 'string') {
    const p = fieldPath(n.object);
    return p === null ? null : [...p, n.index.value];
  }
  return null;
}

function literalNumber(n: Node | undefined): number | null {
  if (n === undefined) return null;
  if (n.type === 'number') return n.value;
  if (n.type === 'unary' && n.op === '-' && n.operand.type === 'number') return -n.operand.value;
  return null;
}

function equalityCompatible(a: Kind, b: Kind): boolean {
  if (a === 'null' || b === 'null') return true;
  if (a === b) return a !== 'duration' && a !== 'money';
  return (a === 'money' && b === 'number') || (a === 'number' && b === 'money');
}

function orderingCompatible(a: Kind, b: Kind): boolean {
  if (a === 'null' || b === 'null')
    return a !== 'bool' && b !== 'bool' && a !== 'duration' && b !== 'duration' && !(a === 'null' && b === 'null');
  if (a === b) return a === 'number' || a === 'string' || a === 'date';
  return (a === 'money' && b === 'number') || (a === 'number' && b === 'money');
}

class SqlCompiler {
  readonly params: unknown[] = [];

  constructor(private readonly opts: SqlCompileOptions) {}

  private param(value: unknown, cast: string): string {
    this.params.push(value);
    return `$${(this.opts.paramOffset ?? 0) + this.params.length}::${cast}`;
  }

  condition(n: Node): string {
    if (n.type === 'bool') return n.value ? 'TRUE' : 'FALSE';
    if (n.type === 'null') return 'FALSE';
    if (n.type === 'unary' && n.op === 'not') return `(NOT ${this.condition(n.operand)})`;
    if (n.type === 'binary') {
      if (n.op === 'and') return `(${this.condition(n.left)} AND ${this.condition(n.right)})`;
      if (n.op === 'or') return `(${this.condition(n.left)} OR ${this.condition(n.right)})`;
      if (n.op === '==' || n.op === '!=') {
        const l = this.value(n.left);
        const r = this.value(n.right);
        if (!equalityCompatible(l.kind, r.kind)) throw new Unsupported(n);
        return `(${l.sql} IS ${n.op === '==' ? 'NOT ' : ''}DISTINCT FROM ${r.sql})`;
      }
      if (ORDERING.includes(n.op)) {
        const l = this.value(n.left);
        const r = this.value(n.right);
        if (!orderingCompatible(l.kind, r.kind)) throw new Unsupported(n);
        const left = l.kind === 'string' ? `${l.sql} COLLATE "C"` : l.sql;
        const right = l.kind !== 'string' && r.kind === 'string' ? `${r.sql} COLLATE "C"` : r.sql;
        return `COALESCE((${left} ${n.op} ${right}), FALSE)`;
      }
      if (n.op === 'in') {
        if (n.right.type !== 'list') throw new Unsupported(n.right);
        const l = this.value(n.left);
        if (n.right.items.length === 0) return 'FALSE';
        const parts = n.right.items.map((item) => {
          if (!['number', 'string', 'bool', 'null'].includes(item.type) && literalNumber(item) === null)
            throw new Unsupported(item);
          const r = this.value(item);
          if (!equalityCompatible(l.kind, r.kind)) throw new Unsupported(item);
          return `${l.sql} IS NOT DISTINCT FROM ${r.sql}`;
        });
        return `(${parts.join(' OR ')})`;
      }
      throw new Unsupported(n);
    }
    const path = fieldPath(n);
    if (path !== null) {
      const v = this.value(n);
      if (v.kind !== 'bool') throw new Unsupported(n);
      return `COALESCE(${v.sql}, FALSE)`;
    }
    throw new Unsupported(n);
  }

  value(n: Node): Value {
    switch (n.type) {
      case 'number':
        return { sql: this.param(n.value, 'numeric'), kind: 'number' };
      case 'string':
        return { sql: this.param(n.value, 'text'), kind: 'string' };
      case 'bool':
        return { sql: n.value ? 'TRUE' : 'FALSE', kind: 'bool' };
      case 'null':
        return { sql: 'NULL', kind: 'null' };
      case 'unary': {
        const lit = literalNumber(n);
        if (lit !== null) return { sql: this.param(lit, 'numeric'), kind: 'number' };
        if (n.op === 'not') return { sql: this.condition(n), kind: 'bool' };
        throw new Unsupported(n);
      }
      case 'call':
        return this.call(n);
      case 'binary': {
        if (BOOL_OPS.includes(n.op)) return { sql: this.condition(n), kind: 'bool' };
        if (n.op !== '+' && n.op !== '-') throw new Unsupported(n);
        const l = this.value(n.left);
        const r = this.value(n.right);
        if (l.kind === 'date' && r.kind === 'duration') return { sql: `(${l.sql} ${n.op} ${r.sql})`, kind: 'date' };
        if (n.op === '+' && l.kind === 'duration' && r.kind === 'date')
          return { sql: `(${r.sql} + ${l.sql})`, kind: 'date' };
        throw new Unsupported(n);
      }
      default: {
        const path = fieldPath(n);
        if (path === null) throw new Unsupported(n);
        const field = this.opts.resolveField(path);
        if (field === null) throw new Unsupported(n);
        const kind = base(field.type).kind;
        if (!['number', 'string', 'bool', 'date', 'money'].includes(kind)) throw new Unsupported(n);
        return { sql: field.sql, kind: kind as Kind };
      }
    }
  }

  private call(n: Extract<Node, { type: 'call' }>): Value {
    if (n.callee === 'now' && n.args.length === 0) {
      const now = this.opts.now;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Unsupported(n);
      return { sql: this.param(now.toISOString(), 'timestamptz'), kind: 'date' };
    }
    if ((n.callee === 'days' || n.callee === 'hours') && n.args.length === 1) {
      const lit = literalNumber(n.args[0]);
      if (lit === null) throw new Unsupported(n);
      const ms = lit * (n.callee === 'days' ? DAY_MS : HOUR_MS);
      if (!Number.isFinite(ms)) throw new Unsupported(n);
      return { sql: `(${this.param(ms, 'float8')} * INTERVAL '1 millisecond')`, kind: 'duration' };
    }
    throw new Unsupported(n);
  }
}

export function compileToSql(ast: Node, opts: SqlCompileOptions): SqlCompileResult {
  const compiler = new SqlCompiler(opts);
  try {
    const sql = compiler.condition(ast);
    return { ok: true, sql, params: compiler.params };
  } catch (e) {
    const span = e instanceof Unsupported ? e.node.span : ast.span;
    return {
      ok: false,
      diagnostics: [makeDiagnostic('sql_unsupported', 'condition too complex for scanning', span, undefined)],
    };
  }
}
