import { ExprError } from './errors';
import type { Span, Token } from './types';

export const KEYWORDS: readonly string[] = ['and', 'or', 'not', 'in', 'true', 'false', 'null'];

export interface LexError {
  code: string;
  message: string;
  span: Span;
}

export interface LexOutput {
  tokens: Token[];
  errors: LexError[];
  end: number;
  closed: boolean;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentPart = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);

const TWO_CHAR = ['==', '!=', '<=', '>=', '?.'];
const OPERATOR_CHARS = '<>+-*/%?:.';
const PUNCT_CHARS = ',()[]';

export function lexRange(src: string, start: number, end: number, template: boolean): LexOutput {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = start;
  let closed = false;
  const push = (kind: Token['kind'], value: string, s: number, e: number): void => {
    tokens.push({ kind, value, span: { start: s, end: e } });
  };
  const error = (code: string, message: string, s: number, e: number): void => {
    errors.push({ code, message, span: { start: s, end: e } });
    push('error', src.slice(s, e), s, e);
  };
  const afterDot = (): boolean => {
    const last = tokens[tokens.length - 1];
    return last !== undefined && last.kind === 'operator' && (last.value === '.' || last.value === '?.');
  };

  while (i < end) {
    const c = src[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (template && c === '}' && src[i + 1] === '}' && i + 1 < end) {
      closed = true;
      break;
    }
    const s = i;
    if (isDigit(c)) {
      while (i < end && isDigit(src[i])) i++;
      if (src[i] === '.' && i + 1 < end && isDigit(src[i + 1])) {
        i++;
        while (i < end && isDigit(src[i])) i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && i + 1 < end) {
        const sign = src[i + 1] === '+' || src[i + 1] === '-';
        const digitAt = sign ? i + 2 : i + 1;
        if (digitAt < end && isDigit(src[digitAt])) {
          i = digitAt;
          while (i < end && isDigit(src[i])) i++;
        }
      }
      const text = src.slice(s, i);
      if (!Number.isFinite(Number(text))) error('invalid_number', `Number literal '${text}' is out of range`, s, i);
      else push('number', text, s, i);
      continue;
    }
    if (isIdentStart(c)) {
      while (i < end && isIdentPart(src[i])) i++;
      const word = src.slice(s, i);
      push(!afterDot() && KEYWORDS.includes(word) ? 'keyword' : 'ident', word, s, i);
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      let value = '';
      let terminated = false;
      let bad: LexError | null = null;
      while (i < end) {
        const ch = src[i] ?? '';
        if (ch === c) {
          terminated = true;
          i++;
          break;
        }
        if (ch === '\\') {
          const next = src[i + 1];
          if (i + 1 >= end || next === undefined) {
            i++;
            break;
          }
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
          const mapped = simple[next];
          if (mapped !== undefined) {
            value += mapped;
            i += 2;
            continue;
          }
          if (next === 'u' && src[i + 2] === '{') {
            let j = i + 3;
            while (j < end && isHex(src[j])) j++;
            const hex = src.slice(i + 3, j);
            if (src[j] === '}' && hex.length >= 1 && hex.length <= 6 && parseInt(hex, 16) <= 0x10ffff) {
              value += String.fromCodePoint(parseInt(hex, 16));
              i = j + 1;
              continue;
            }
            bad ??= {
              code: 'invalid_escape',
              message: 'Invalid unicode escape',
              span: { start: i, end: Math.min(j + 1, end) },
            };
            i = Math.min(j + 1, end);
            continue;
          }
          bad ??= {
            code: 'invalid_escape',
            message: `Invalid escape sequence '\\${next}'`,
            span: { start: i, end: i + 2 },
          };
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      if (!terminated) {
        error('unterminated_string', 'Unterminated string literal', s, i);
        continue;
      }
      if (bad !== null) {
        errors.push(bad);
        push('error', src.slice(s, i), s, i);
        continue;
      }
      push('string', value, s, i);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (i + 1 < end && TWO_CHAR.includes(two)) {
      push('operator', two, s, i + 2);
      i += 2;
      continue;
    }
    if (c !== undefined && OPERATOR_CHARS.includes(c)) {
      push('operator', c, s, i + 1);
      i++;
      continue;
    }
    if (c !== undefined && PUNCT_CHARS.includes(c)) {
      push('punct', c, s, i + 1);
      i++;
      continue;
    }
    const cp = src.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    const shown = c === '=' ? "'=' (use '==' for comparison)" : `'${src.slice(i, i + width)}'`;
    error('unexpected_char', `Unexpected character ${shown}`, s, Math.min(i + width, end));
    i += width;
  }
  return { tokens, errors, end: Math.min(i, end), closed };
}

export function tokenize(src: string, opts?: { tolerant?: boolean }): Token[] {
  const out = lexRange(src, 0, src.length, false);
  const first = out.errors[0];
  if (opts?.tolerant !== true && first !== undefined) throw new ExprError(first.code, first.message, first.span);
  out.tokens.push({ kind: 'eof', value: '', span: { start: src.length, end: src.length } });
  return out.tokens;
}

export interface TemplateScan {
  kind: 'text' | 'expr';
  start: number;
  end: number;
  open?: Span;
  close?: Span;
  lex?: LexOutput;
}

export function scanTemplate(src: string): TemplateScan[] {
  const parts: TemplateScan[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open < 0) {
      parts.push({ kind: 'text', start: i, end: src.length });
      break;
    }
    if (open > i) parts.push({ kind: 'text', start: i, end: open });
    const lex = lexRange(src, open + 2, src.length, true);
    if (lex.closed) {
      parts.push({
        kind: 'expr',
        start: open + 2,
        end: lex.end,
        open: { start: open, end: open + 2 },
        close: { start: lex.end, end: lex.end + 2 },
        lex,
      });
      i = lex.end + 2;
    } else {
      parts.push({ kind: 'expr', start: open + 2, end: src.length, open: { start: open, end: open + 2 }, lex });
      i = src.length;
    }
  }
  return parts;
}

export function tokenizeTemplate(src: string): Token[] {
  const tokens: Token[] = [];
  for (const part of scanTemplate(src)) {
    if (part.kind === 'text') {
      tokens.push({ kind: 'text', value: src.slice(part.start, part.end), span: { start: part.start, end: part.end } });
      continue;
    }
    if (part.open !== undefined) tokens.push({ kind: 'template-open', value: '{{', span: part.open });
    tokens.push(...(part.lex?.tokens ?? []));
    if (part.close !== undefined) tokens.push({ kind: 'template-close', value: '}}', span: part.close });
  }
  tokens.push({ kind: 'eof', value: '', span: { start: src.length, end: src.length } });
  return tokens;
}
