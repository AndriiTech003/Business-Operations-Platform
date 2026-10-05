import {
  analyze,
  complete,
  tokenize,
  tokenizeTemplate,
  typeToString,
  type Token,
  type Type,
  type TypeContext,
} from '@ashamrai/expr';
import { assignableToAny } from '@bop/workflow-core';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

export type TokenClass = 'number' | 'string' | 'keyword' | 'field' | 'fn' | 'var' | 'op' | 'punct' | 'tpl' | 'error';

export interface ClassifiedToken {
  from: number;
  to: number;
  cls: TokenClass;
}

export function classifyTokens(src: string, template: boolean): ClassifiedToken[] {
  let tokens: Token[];
  try {
    tokens = template ? tokenizeTemplate(src) : tokenize(src, { tolerant: true });
  } catch {
    return [];
  }
  const out: ClassifiedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === 'eof' || t.kind === 'text' || t.span.end <= t.span.start) continue;
    let cls: TokenClass | null;
    switch (t.kind) {
      case 'number':
        cls = 'number';
        break;
      case 'string':
        cls = 'string';
        break;
      case 'keyword':
        cls = 'keyword';
        break;
      case 'operator':
        cls = 'op';
        break;
      case 'punct':
        cls = 'punct';
        break;
      case 'template-open':
      case 'template-close':
        cls = 'tpl';
        break;
      case 'error':
        cls = 'error';
        break;
      case 'ident': {
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        if (prev !== undefined && prev.kind === 'operator' && (prev.value === '.' || prev.value === '?.'))
          cls = 'field';
        else if (next !== undefined && next.kind === 'punct' && next.value === '(') cls = 'fn';
        else cls = 'var';
        break;
      }
      default:
        cls = null;
    }
    if (cls !== null) out.push({ from: t.span.start, to: Math.min(t.span.end, src.length), cls });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

export interface ExprDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
  code: string;
}

export function diagnoseExpression(
  src: string,
  ctx: TypeContext,
  opts: { template?: boolean; expected?: readonly Type[] } = {},
): ExprDiagnostic[] {
  if (src.trim() === '') return [];
  const result = analyze(src, ctx, { template: opts.template === true });
  const out: ExprDiagnostic[] = result.diagnostics.map((d) => ({
    from: Math.max(0, Math.min(d.span.start, src.length)),
    to: Math.max(0, Math.min(Math.max(d.span.end, d.span.start), src.length)),
    severity: d.severity,
    message: d.message,
    code: d.code,
  }));
  const hasError = out.some((d) => d.severity === 'error');
  if (
    !hasError &&
    opts.template !== true &&
    opts.expected !== undefined &&
    opts.expected.length > 0 &&
    !assignableToAny(result.type, opts.expected)
  ) {
    out.push({
      from: 0,
      to: src.length,
      severity: 'error',
      code: 'type_mismatch',
      message: `Expected ${opts.expected.map(typeToString).join(' | ')}, got ${typeToString(result.type)}`,
    });
  }
  return out;
}

const KIND_TO_CM: Record<string, string> = {
  field: 'property',
  function: 'function',
  variable: 'variable',
  keyword: 'keyword',
};

export function createCompletionSource(getContext: () => TypeContext, template: boolean): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const src = context.state.doc.toString();
    const result = complete(src, context.pos, getContext(), { template });
    const before = src.slice(Math.max(0, context.pos - 2), context.pos);
    const afterDot = /\.$|\?\.$/.test(before);
    const typedWord = result.from < context.pos;
    if (result.options.length === 0) return null;
    if (!context.explicit && !afterDot && !typedWord) return null;
    const options: Completion[] = result.options.map((o, i) => ({
      label: o.label,
      type: KIND_TO_CM[o.kind] ?? 'text',
      detail: o.type,
      info: o.detail,
      apply: o.apply,
      boost: o.kind === 'field' || o.kind === 'variable' ? 10 - Math.min(i, 9) * 0.01 : o.kind === 'function' ? 0 : -10,
    }));
    return { from: result.from, to: result.to, options, validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
  };
}
