import { ExprError, MAX_DEPTH, isForbidden, makeDiagnostic, resolveLimits } from './errors';
import { lexRange, scanTemplate } from './lexer';
import type {
  BinaryOp,
  Diagnostic,
  Limits,
  Node,
  ParseResult,
  ParsedTemplate,
  Span,
  TemplatePart,
  Token,
} from './types';

class Fatal {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly span: Span,
  ) {}
}

const COMPARE_OPS = ['==', '!=', '<', '<=', '>', '>=', 'in'];
const SUM_OPS = ['+', '-'];
const PRODUCT_OPS = ['*', '/', '%'];

const BP_TERNARY = 1;
const BP_OR = 2;
const BP_AND = 3;
const BP_NOT = 4;
const BP_COMPARE = 5;
const BP_SUM = 6;
const BP_PRODUCT = 7;
const BP_UNARY = 8;
const BP_POSTFIX = 9;

function describeToken(t: Token): string {
  if (t.kind === 'eof') return 'end of expression';
  return `'${t.kind === 'string' ? '<string>' : t.value}'`;
}

class Parser {
  private pos = 0;
  private depth = 0;
  private bareIdent: Node | null = null;
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
    private readonly limits: Limits,
  ) {}

  private peek(): Token {
    return (
      this.tokens[this.pos] ??
      this.tokens[this.tokens.length - 1] ?? { kind: 'eof', value: '', span: { start: 0, end: 0 } }
    );
  }

  private advance(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private is(value: string): boolean {
    const t = this.peek();
    return (t.kind === 'operator' || t.kind === 'punct' || t.kind === 'keyword') && t.value === value;
  }

  private expect(value: string, context: string): Token {
    if (this.is(value)) return this.advance();
    const t = this.peek();
    throw new Fatal('parse_error', `Expected '${value}' ${context} but found ${describeToken(t)}`, t.span);
  }

  private report(code: string, message: string, span: Span): void {
    this.diagnostics.push(makeDiagnostic(code, message, span, this.src));
  }

  parseRoot(): Node {
    const node = this.parseExpr(0);
    const t = this.peek();
    if (t.kind !== 'eof') {
      if (t.kind === 'operator' && COMPARE_OPS.includes(t.value)) {
        throw new Fatal('parse_error', 'Comparison operators cannot be chained; use parentheses', t.span);
      }
      throw new Fatal('parse_error', `Unexpected token ${describeToken(t)}`, t.span);
    }
    return node;
  }

  private infixBp(t: Token): number {
    if (t.kind === 'keyword') {
      if (t.value === 'or') return BP_OR;
      if (t.value === 'and') return BP_AND;
      if (t.value === 'in') return BP_COMPARE;
      return 0;
    }
    if (t.kind === 'operator') {
      if (t.value === '?') return BP_TERNARY;
      if (COMPARE_OPS.includes(t.value)) return BP_COMPARE;
      if (SUM_OPS.includes(t.value)) return BP_SUM;
      if (PRODUCT_OPS.includes(t.value)) return BP_PRODUCT;
      if (t.value === '.' || t.value === '?.') return BP_POSTFIX;
      return 0;
    }
    if (t.kind === 'punct' && (t.value === '[' || t.value === '(')) return BP_POSTFIX;
    return 0;
  }

  private parseExpr(rbp: number): Node {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new Fatal('too_deep', `Expression is nested more than ${MAX_DEPTH} levels deep`, this.peek().span);
    }
    let left = this.nud(rbp);
    for (;;) {
      const t = this.peek();
      const bp = this.infixBp(t);
      if (bp <= rbp) break;
      left = this.led(t, left);
    }
    this.depth--;
    return left;
  }

  private nud(rbp: number): Node {
    const t = this.advance();
    this.bareIdent = null;
    switch (t.kind) {
      case 'number':
        return { type: 'number', value: Number(t.value), span: t.span };
      case 'string':
        return { type: 'string', value: t.value, span: t.span };
      case 'ident': {
        if (isForbidden(t.value)) {
          this.report('forbidden_identifier', `Identifier '${t.value}' is not allowed`, t.span);
        }
        const node: Node = { type: 'ident', name: t.value, span: t.span };
        this.bareIdent = node;
        return node;
      }
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') return { type: 'bool', value: t.value === 'true', span: t.span };
        if (t.value === 'null') return { type: 'null', span: t.span };
        if (t.value === 'not') {
          if (rbp >= BP_NOT) throw new Fatal('parse_error', "'not' must be wrapped in parentheses here", t.span);
          const operand = this.parseExpr(BP_AND);
          return { type: 'unary', op: 'not', operand, span: { start: t.span.start, end: operand.span.end } };
        }
        break;
      case 'operator':
        if (t.value === '-') {
          const operand = this.parseExpr(BP_UNARY);
          return { type: 'unary', op: '-', operand, span: { start: t.span.start, end: operand.span.end } };
        }
        break;
      case 'punct':
        if (t.value === '(') {
          const inner = this.parseExpr(0);
          const close = this.expect(')', 'to close parenthesis');
          return { ...inner, span: { start: t.span.start, end: close.span.end } };
        }
        if (t.value === '[') {
          const items: Node[] = [];
          if (!this.is(']')) {
            for (;;) {
              items.push(this.parseExpr(0));
              if (!this.is(',')) break;
              this.advance();
            }
          }
          const close = this.expect(']', 'to close list');
          const span = { start: t.span.start, end: close.span.end };
          if (items.length > this.limits.maxListLength) {
            this.report('list_too_long', `List literal has more than ${this.limits.maxListLength} items`, span);
          }
          return { type: 'list', items, span };
        }
        break;
      case 'eof':
        throw new Fatal('parse_error', 'Unexpected end of expression', t.span);
      default:
        break;
    }
    throw new Fatal('parse_error', `Unexpected token ${describeToken(t)}`, t.span);
  }

  private led(t: Token, left: Node): Node {
    const wasBare = this.bareIdent === left;
    this.bareIdent = null;
    this.advance();
    const op = t.value;
    if (t.kind === 'punct' && op === '(') {
      const args: Node[] = [];
      if (!this.is(')')) {
        for (;;) {
          args.push(this.parseExpr(0));
          if (!this.is(',')) break;
          this.advance();
        }
      }
      const close = this.expect(')', 'to close argument list');
      const span = { start: left.span.start, end: close.span.end };
      if (!wasBare || left.type !== 'ident') {
        this.report('not_callable', 'Only whitelisted functions can be called, e.g. len(x)', span);
        return { type: 'call', callee: '', args, span };
      }
      return { type: 'call', callee: left.name, args, span };
    }
    if (t.kind === 'punct' && op === '[') {
      const index = this.parseExpr(0);
      const close = this.expect(']', 'to close index');
      return { type: 'index', object: left, index, span: { start: left.span.start, end: close.span.end } };
    }
    if (op === '.' || op === '?.') {
      const name = this.advance();
      if (name.kind !== 'ident') {
        throw new Fatal(
          'parse_error',
          `Expected a field name after '${op}' but found ${describeToken(name)}`,
          name.span,
        );
      }
      if (isForbidden(name.value)) {
        this.report('forbidden_identifier', `Field name '${name.value}' is not allowed`, name.span);
      }
      return {
        type: 'member',
        object: left,
        property: name.value,
        optional: op === '?.',
        span: { start: left.span.start, end: name.span.end },
      };
    }
    if (op === '?') {
      const consequent = this.parseExpr(0);
      this.expect(':', 'in conditional expression');
      const alternate = this.parseExpr(0);
      return {
        type: 'ternary',
        test: left,
        consequent,
        alternate,
        span: { start: left.span.start, end: alternate.span.end },
      };
    }
    const bp = this.infixBp(t);
    const right = this.parseExpr(bp === BP_COMPARE ? BP_COMPARE : bp);
    const node: Node = {
      type: 'binary',
      op: op as BinaryOp,
      left,
      right,
      span: { start: left.span.start, end: right.span.end },
    };
    if (bp === BP_COMPARE) {
      const next = this.peek();
      if (this.infixBp(next) === BP_COMPARE) {
        throw new Fatal('parse_error', 'Comparison operators cannot be chained; use parentheses', next.span);
      }
    }
    return node;
  }
}

export function countNodes(ast: Node): number {
  let count = 0;
  const stack: Node[] = [ast];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    count++;
    for (const child of children(n)) stack.push(child);
  }
  return count;
}

export function children(n: Node): Node[] {
  switch (n.type) {
    case 'list':
      return n.items;
    case 'member':
      return [n.object];
    case 'index':
      return [n.object, n.index];
    case 'call':
      return n.args;
    case 'unary':
      return [n.operand];
    case 'binary':
      return [n.left, n.right];
    case 'ternary':
      return [n.test, n.consequent, n.alternate];
    default:
      return [];
  }
}

export function stripSpans(ast: Node): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ast)) {
    if (key === 'span') continue;
    if (Array.isArray(value)) out[key] = value.map((v: Node) => stripSpans(v));
    else if (typeof value === 'object' && value !== null) out[key] = stripSpans(value as Node);
    else out[key] = value;
  }
  return out;
}

function parseTokens(tokens: Token[], src: string, limits: Limits, startDiags: Diagnostic[]): ParseResult {
  const diagnostics = [...startDiags];
  if (diagnostics.some((d) => d.severity === 'error')) return { ast: null, diagnostics };
  const parser = new Parser(tokens, src, limits);
  let ast: Node;
  try {
    ast = parser.parseRoot();
  } catch (e) {
    if (!(e instanceof Fatal)) throw e;
    diagnostics.push(...parser.diagnostics, makeDiagnostic(e.code, e.message, e.span, src));
    return { ast: null, diagnostics };
  }
  diagnostics.push(...parser.diagnostics);
  const nodes = countNodes(ast);
  if (nodes > limits.maxAstNodes) {
    diagnostics.push(
      makeDiagnostic(
        'too_many_nodes',
        `Expression has ${nodes} nodes; the limit is ${limits.maxAstNodes}`,
        ast.span,
        src,
      ),
    );
  }
  return { ast: diagnostics.some((d) => d.severity === 'error') ? null : ast, diagnostics };
}

function parseSegment(src: string, start: number, end: number, limits: Limits): ParseResult {
  if (end - start > limits.maxExpressionLength) {
    return {
      ast: null,
      diagnostics: [
        makeDiagnostic(
          'too_long',
          `Expression is ${end - start} characters long; the limit is ${limits.maxExpressionLength}`,
          { start: start + limits.maxExpressionLength, end },
          src,
        ),
      ],
    };
  }
  const lex = lexRange(src, start, end, false);
  lex.tokens.push({ kind: 'eof', value: '', span: { start: end, end } });
  const lexDiags = lex.errors.map((e) => makeDiagnostic(e.code, e.message, e.span, src));
  return parseTokens(lex.tokens, src, limits, lexDiags);
}

export function parse(src: string, limits?: Partial<Limits>): ParseResult {
  try {
    if (src.trim() === '') {
      return {
        ast: null,
        diagnostics: [makeDiagnostic('parse_error', 'Expression is empty', { start: 0, end: src.length }, src)],
      };
    }
    return parseSegment(src, 0, src.length, resolveLimits(limits));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Parse failed';
    return { ast: null, diagnostics: [makeDiagnostic('parse_error', message, { start: 0, end: src.length }, src)] };
  }
}

export function parseOrThrow(src: string): Node {
  const result = parse(src);
  const error = result.diagnostics.find((d) => d.severity === 'error');
  if (result.ast === null || error !== undefined) {
    const d = error ?? result.diagnostics[0];
    throw new ExprError(
      d?.code ?? 'parse_error',
      d?.message ?? 'Parse failed',
      d?.span ?? { start: 0, end: src.length },
    );
  }
  return result.ast;
}

export function parseTemplate(src: string, limits?: Partial<Limits>): ParsedTemplate {
  const lim = resolveLimits(limits);
  const parts: TemplatePart[] = [];
  const diagnostics: Diagnostic[] = [];
  try {
    if (src.length > lim.maxStringLength) {
      diagnostics.push(
        makeDiagnostic(
          'too_long',
          `Template is ${src.length} characters long; the limit is ${lim.maxStringLength}`,
          { start: lim.maxStringLength, end: src.length },
          src,
        ),
      );
      return { parts, diagnostics };
    }
    for (const scan of scanTemplate(src)) {
      if (scan.kind === 'text') {
        parts.push({
          kind: 'text',
          value: src.slice(scan.start, scan.end),
          span: { start: scan.start, end: scan.end },
        });
        continue;
      }
      const open = scan.open ?? { start: scan.start, end: scan.start };
      if (scan.close === undefined) {
        diagnostics.push(
          makeDiagnostic('unclosed_template', "Unclosed '{{' in template", { start: open.start, end: src.length }, src),
        );
        continue;
      }
      const span = { start: open.start, end: scan.close.end };
      const source = src.slice(scan.start, scan.end);
      if (source.trim() === '') {
        diagnostics.push(makeDiagnostic('parse_error', 'Empty expression in template', span, src));
        continue;
      }
      const result = parseSegment(src, scan.start, scan.end, lim);
      diagnostics.push(...result.diagnostics);
      if (result.ast !== null) parts.push({ kind: 'expr', source: source.trim(), ast: result.ast, span });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Template parse failed';
    diagnostics.push(makeDiagnostic('parse_error', message, { start: 0, end: src.length }, src));
  }
  return { parts, diagnostics };
}
