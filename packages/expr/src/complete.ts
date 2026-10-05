import { check } from './checker';
import { FUNCTION_SPECS } from './functions';
import { KEYWORDS, lexRange, scanTemplate } from './lexer';
import { parse } from './parser';
import { T, base, fieldsOf, typeToString } from './typesys';
import type { Completion, CompletionResult, Token, TypeContext } from './types';

const IDENT_TAIL = /[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

function isClose(t: Token | undefined): boolean {
  return t !== undefined && t.kind === 'punct' && (t.value === ')' || t.value === ']');
}

function isValueEnd(t: Token | undefined): boolean {
  if (t === undefined) return false;
  if (t.kind === 'ident' || t.kind === 'number' || t.kind === 'string') return true;
  if (t.kind === 'keyword') return t.value === 'true' || t.value === 'false' || t.value === 'null';
  return isClose(t);
}

function chainStart(tokens: Token[]): number | null {
  let i = tokens.length - 1;
  while (i >= 0) {
    const t = tokens[i];
    if (t === undefined) return null;
    if (isClose(t)) {
      const open = t.value === ')' ? '(' : '[';
      let depth = 0;
      let j = i;
      for (; j >= 0; j--) {
        const u = tokens[j];
        if (u === undefined) return null;
        if (u.kind === 'punct' && (u.value === ')' || u.value === ']')) depth++;
        if (u.kind === 'punct' && (u.value === '(' || u.value === '[')) depth--;
        if (depth === 0) break;
      }
      const opener = tokens[j];
      if (j < 0 || opener === undefined || opener.value !== open) return null;
      const prev = tokens[j - 1];
      if (open === '(' && prev?.kind !== 'ident') return j;
      if (open === '[' && !isValueEnd(prev)) return j;
      i = j - 1;
      continue;
    }
    if (isValueEnd(t)) {
      const prev = tokens[i - 1];
      if (t.kind === 'ident' && prev?.kind === 'operator' && (prev.value === '.' || prev.value === '?.')) {
        i -= 2;
        continue;
      }
      return i;
    }
    return null;
  }
  return null;
}

function memberOptions(src: string, start: number, end: number, ctx: TypeContext): Completion[] | null {
  const lex = lexRange(src, start, end, false);
  const tokens = lex.tokens;
  const last = tokens[tokens.length - 1];
  if (last === undefined || last.kind !== 'operator' || (last.value !== '.' && last.value !== '?.')) return null;
  const head = tokens.slice(0, -1);
  const first = chainStart(head);
  if (first === null) return [];
  const firstToken = head[first];
  if (firstToken === undefined) return [];
  const exprText = src.slice(firstToken.span.start, last.span.start);
  const parsed = parse(exprText);
  if (parsed.ast === null) return [];
  const type = base(check(parsed.ast, ctx).type);
  const fields = fieldsOf(type);
  if (fields === null) return [];
  return Object.entries(fields).map(([name, f]) => {
    const option: Completion = { label: name, kind: 'field', type: typeToString(f.type) };
    const detail = f.label ?? f.description;
    if (detail !== undefined) option.detail = detail;
    return option;
  });
}

function globalOptions(ctx: TypeContext): Completion[] {
  const vars: Completion[] = Object.entries(ctx.vars)
    .map(([name, t]): Completion => ({ label: name, kind: 'variable', type: typeToString(t ?? T.any) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const fns: Completion[] = FUNCTION_SPECS.filter((f) => f.name !== 'secret' || ctx.allowSecret === true).map((f) => ({
    label: f.name,
    kind: 'function',
    type: f.signature.slice(f.signature.lastIndexOf(':') + 1).trim(),
    detail: f.signature,
    apply: `${f.name}(`,
  }));
  const kws: Completion[] = KEYWORDS.map((k) => ({ label: k, kind: 'keyword' }));
  return [...vars, ...fns, ...kws];
}

function completeRange(src: string, start: number, offset: number, ctx: TypeContext): CompletionResult {
  const prefix = src.slice(start, offset);
  const lex = lexRange(src, start, offset, false);
  const lastToken = lex.tokens[lex.tokens.length - 1];
  if (
    lastToken !== undefined &&
    lastToken.span.end >= offset &&
    (lastToken.kind === 'string' || lastToken.kind === 'number')
  ) {
    return { from: offset, to: offset, options: [] };
  }
  if (lastToken !== undefined && lastToken.kind === 'error' && /^['"]/.test(lastToken.value)) {
    return { from: offset, to: offset, options: [] };
  }
  const partial = IDENT_TAIL.exec(prefix)?.[0] ?? '';
  const from = offset - partial.length;
  let to = offset;
  while (to < src.length && IDENT_CHAR.test(src[to] ?? '')) to++;
  const lower = partial.toLowerCase();
  const before = src.slice(start, from).replace(/\s+$/, '');
  const members = memberOptions(src, start, start + before.length, ctx);
  const pool = members ?? globalOptions(ctx);
  const options = pool.filter((o) => o.label.toLowerCase().startsWith(lower));
  return { from, to, options };
}

export function complete(
  src: string,
  offset: number,
  ctx: TypeContext,
  opts?: { template?: boolean },
): CompletionResult {
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : src.length, src.length));
  try {
    if (opts?.template !== true) return completeRange(src, 0, at, ctx);
    for (const part of scanTemplate(src)) {
      if (part.kind !== 'expr') continue;
      const closeStart = part.close?.start ?? src.length;
      if (at >= part.start && at <= closeStart) return completeRange(src, part.start, at, ctx);
    }
    return { from: at, to: at, options: [] };
  } catch {
    return { from: at, to: at, options: [] };
  }
}
