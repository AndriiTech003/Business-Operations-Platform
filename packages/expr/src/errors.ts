import type { Diagnostic, Limits, Position, Severity, Span } from './types';

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxExpressionLength: 2000,
  maxAstNodes: 500,
  maxStringLength: 10000,
  maxListLength: 1000,
});

export const MAX_DEPTH = 200;

export const FORBIDDEN_IDENTIFIERS: readonly string[] = Object.freeze(['constructor', '__proto__', 'prototype']);

export function isForbidden(name: string): boolean {
  return FORBIDDEN_IDENTIFIERS.includes(name);
}

export function resolveLimits(limits?: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...(limits ?? {}) };
}

export class ExprError extends Error {
  readonly code: string;
  readonly span: Span;

  constructor(code: string, message: string, span: Span = { start: 0, end: 0 }) {
    super(message);
    this.name = 'ExprError';
    this.code = code;
    this.span = { start: span.start, end: span.end };
  }
}

export class EvalError extends ExprError {
  constructor(code: string, message: string, span: Span = { start: 0, end: 0 }) {
    super(code, message, span);
    this.name = 'EvalError';
  }
}

export function offsetToPosition(src: string, offset: number): Position {
  const end = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, src.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: end - lineStart + 1 };
}

export function makeDiagnostic(
  code: string,
  message: string,
  span: Span,
  src: string | undefined,
  severity: Severity = 'error',
): Diagnostic {
  const start = src === undefined ? { line: 1, col: span.start + 1 } : offsetToPosition(src, span.start);
  const end = src === undefined ? { line: 1, col: span.end + 1 } : offsetToPosition(src, span.end);
  return { severity, code, message, span: { start: span.start, end: span.end }, start, end };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + cost);
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

export function suggest(name: string, candidates: Iterable<string>): string | null {
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  let best: string | null = null;
  let bestDistance = Infinity;
  const lower = name.toLowerCase();
  for (const candidate of candidates) {
    const distance = candidate.toLowerCase() === lower ? 0 : levenshtein(name, candidate);
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
  const s = suggest(name, candidates);
  return s === null ? '' : ` Did you mean '${s}'?`;
}
