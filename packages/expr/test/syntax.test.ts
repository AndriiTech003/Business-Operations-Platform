import { describe, expect, it } from 'vitest';
import {
  ExprError,
  countNodes,
  parse,
  parseOrThrow,
  parseTemplate,
  print,
  stripSpans,
  tokenize,
  tokenizeTemplate,
} from '../src/index';
import type { Limits, TokenKind } from '../src/index';
import { sexpr } from './fixtures';

const kinds = (src: string): string =>
  tokenize(src, { tolerant: true })
    .map((t) => `${t.kind}:${t.value}`)
    .join(' ');

const lexCases: [string, string, string][] = [
  ['integer', '12', 'number:12 eof:'],
  ['decimal', '1.5', 'number:1.5 eof:'],
  ['exponent', '1e3', 'number:1e3 eof:'],
  ['negative exponent', '2.5e-3', 'number:2.5e-3 eof:'],
  ['positive exponent', '1E+21', 'number:1E+21 eof:'],
  ['single-quoted string with newline escape', "'a\\nb'", 'string:a\nb eof:'],
  ['double-quoted string with escaped quote', '"x\\"y"', 'string:x"y eof:'],
  ['unicode escape', "'\\u{1F600}'", 'string:\u{1F600} eof:'],
  ['tab, carriage return and backslash escapes', "'\\t\\r\\\\'", 'string:\t\r\\ eof:'],
  ['escaped single quote', "'it\\'s'", "string:it's eof:"],
  ['identifier', 'foo_Bar1', 'ident:foo_Bar1 eof:'],
  [
    'keywords',
    'and or not in true false null',
    'keyword:and keyword:or keyword:not keyword:in keyword:true keyword:false keyword:null eof:',
  ],
  ['keyword after dot is a property name', 'a.and', 'ident:a operator:. ident:and eof:'],
  ['keyword after ?. is a property name', 'a?.not', 'ident:a operator:?. ident:not eof:'],
  [
    'comparison operators',
    '== != <= >= < >',
    'operator:== operator:!= operator:<= operator:>= operator:< operator:> eof:',
  ],
  [
    'arithmetic and ternary operators',
    '+ - * / % ? :',
    'operator:+ operator:- operator:* operator:/ operator:% operator:? operator:: eof:',
  ],
  ['punctuation', ', ( ) [ ]', 'punct:, punct:( punct:) punct:[ punct:] eof:'],
  ['number followed by member access', '1.foo', 'number:1 operator:. ident:foo eof:'],
  ['tolerant mode emits error tokens', 'a # b', 'ident:a error:# ident:b eof:'],
  ['tolerant unterminated string', "x == 'ab", "ident:x operator:== error:'ab eof:"],
];

describe('lexer', () => {
  it.each(lexCases)('%s', (_name, src, expected) => {
    expect(kinds(src)).toBe(expected);
  });

  const errorCases: [string, string][] = [
    ["'abc", 'unterminated_string'],
    ["'\\q'", 'invalid_escape'],
    ["'\\u{110000}'", 'invalid_escape'],
    ['1e999', 'invalid_number'],
    ['a = b', 'unexpected_char'],
    ['a && b', 'unexpected_char'],
  ];
  it.each(errorCases)('strict tokenize of %j throws %s', (src, code) => {
    let err: unknown;
    try {
      tokenize(src);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExprError);
    expect((err as ExprError).code).toBe(code);
  });

  it('token spans are absolute offsets', () => {
    expect(tokenize(' ab  12 ').map((t) => t.span)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
      { start: 8, end: 8 },
    ]);
  });

  const templateCases: [string, string, TokenKind[]][] = [
    ['text and expression', 'Hi {{ name }}!', ['text', 'template-open', 'ident', 'template-close', 'text', 'eof']],
    ["'}}' inside a string literal does not close", "{{ '}}' }}", ['template-open', 'string', 'template-close', 'eof']],
    ['unclosed expression', 'a {{ b', ['text', 'template-open', 'ident', 'eof']],
    ['plain text', 'just text }}', ['text', 'eof']],
    [
      'two expressions back to back',
      '{{a}}{{b}}',
      ['template-open', 'ident', 'template-close', 'template-open', 'ident', 'template-close', 'eof'],
    ],
  ];
  it.each(templateCases)('tokenizeTemplate: %s', (_name, src, expected) => {
    expect(tokenizeTemplate(src).map((t) => t.kind)).toEqual(expected);
  });
});

const precedenceCases: [string, string][] = [
  ['1 + 2 * 3', '(+ 1 (* 2 3))'],
  ['(1 + 2) * 3', '(* (+ 1 2) 3)'],
  ['1 - 2 - 3', '(- (- 1 2) 3)'],
  ['8 / 4 / 2', '(/ (/ 8 4) 2)'],
  ['7 % 3 * 2', '(* (% 7 3) 2)'],
  ['-a * b', '(* (- a) b)'],
  ['- -a', '(- (- a))'],
  ['-a.b', '(- (. a b))'],
  ['1 + -2', '(+ 1 (- 2))'],
  ['a or b and c', '(or a (and b c))'],
  ['a and b or c', '(or (and a b) c)'],
  ['a or b or c', '(or (or a b) c)'],
  ['not a and b', '(and (not a) b)'],
  ['not a == b', '(not (== a b))'],
  ['not not a', '(not (not a))'],
  ['a ? b : c ? d : e', '(? a b (? c d e))'],
  ['a ? b ? c : d : e', '(? a (? b c d) e)'],
  ['a or b ? c : d', '(? (or a b) c d)'],
  ['1 + 2 < 3 * 4', '(< (+ 1 2) (* 3 4))'],
  ['x in [1, 2]', '(in x [1 2])'],
  ['a.b?.c[0]', '([] (?. (. a b) c) 0)'],
  ['len(x) + 1', '(+ (call len x) 1)'],
  ['now()', '(call now)'],
  ['min(1, 2, 3)', '(call min 1 2 3)'],
  ['[]', '[]'],
  ['[1, [2]]', '[1 [2]]'],
  ['a.and.or', '(. (. a and) or)'],
  ['((a))', 'a'],
  ['user("x").name', '(. (call user "x") name)'],
  ['a[b][c]', '([] ([] a b) c)'],
  ['2 * (3 + 4) % 5', '(% (* 2 (+ 3 4)) 5)'],
  ['a\n  and\n  b', '(and a b)'],
];

describe('parser precedence and associativity', () => {
  it.each(precedenceCases)('%j parses as %s', (src, expected) => {
    const result = parse(src);
    expect(result.diagnostics).toEqual([]);
    expect(result.ast).not.toBeNull();
    if (result.ast !== null) expect(sexpr(result.ast)).toBe(expected);
  });
});

const errorCases: [string, string, number, number, Partial<Limits>?][] = [
  ['1 +', 'parse_error', 1, 4],
  ['(1 + 2', 'parse_error', 1, 7],
  ['a == b == c', 'parse_error', 1, 8],
  ['a < b > c', 'parse_error', 1, 7],
  ['a.', 'parse_error', 1, 3],
  ['a.1', 'parse_error', 1, 3],
  ['foo(1)(2)', 'not_callable', 1, 1],
  ['a.b(1)', 'not_callable', 1, 1],
  ['(len)(x)', 'not_callable', 1, 1],
  ['constructor', 'forbidden_identifier', 1, 1],
  ['a.__proto__', 'forbidden_identifier', 1, 3],
  ['x.prototype', 'forbidden_identifier', 1, 3],
  ["'abc", 'unterminated_string', 1, 1],
  ['a = b', 'unexpected_char', 1, 3],
  ['a\n  + * b', 'parse_error', 2, 5],
  ['1 2', 'parse_error', 1, 3],
  ['', 'parse_error', 1, 1],
  ['[1, 2', 'parse_error', 1, 6],
  ['a ? b', 'parse_error', 1, 6],
  ['a == not b', 'parse_error', 1, 6],
  ['-not a', 'parse_error', 1, 2],
  ['\n\n  )', 'parse_error', 3, 3],
  ["'\\x'", 'invalid_escape', 1, 2],
  ['1e999', 'invalid_number', 1, 1],
  ['1 + 2 + 3', 'too_long', 1, 6, { maxExpressionLength: 5 }],
  ['1 + 2 + 3', 'too_many_nodes', 1, 1, { maxAstNodes: 3 }],
  ['[1, 2, 3]', 'list_too_long', 1, 1, { maxListLength: 2 }],
  [`${'('.repeat(300)}1${')'.repeat(300)}`, 'too_deep', 1, 201],
  ['a.b c', 'parse_error', 1, 5],
  ['f(1,)', 'parse_error', 1, 5],
];

describe('parser errors', () => {
  it.each(errorCases)('%j reports %s at %i:%i', (src, code, line, col, limits) => {
    const result = parse(src, limits);
    expect(result.ast).toBeNull();
    const d = result.diagnostics.find((x) => x.severity === 'error');
    expect(d?.code).toBe(code);
    expect(d?.start).toEqual({ line, col });
  });

  it('parseOrThrow throws ExprError with code and span', () => {
    expect(() => parseOrThrow('1 +')).toThrow(ExprError);
    try {
      parseOrThrow('a == b == c');
    } catch (e) {
      expect((e as ExprError).code).toBe('parse_error');
      expect((e as ExprError).span).toEqual({ start: 7, end: 9 });
    }
  });
});

describe('templates', () => {
  it('splits text and expressions with absolute spans', () => {
    const tpl = parseTemplate('Hello {{ name }}!');
    expect(tpl.diagnostics).toEqual([]);
    expect(tpl.parts.map((p) => [p.kind, p.span.start, p.span.end])).toEqual([
      ['text', 0, 6],
      ['expr', 6, 16],
      ['text', 16, 17],
    ]);
    const expr = tpl.parts[1];
    expect(expr?.kind === 'expr' ? [expr.source, expr.ast.span] : null).toEqual(['name', { start: 9, end: 13 }]);
  });

  const cases: [string, string, string[], string | null][] = [
    ['string literal containing }}', "{{ '}}' }}", ['expr'], null],
    ['unclosed {{', 'a {{ b', ['text'], 'unclosed_template'],
    ['empty expression', '{{ }}', [], 'parse_error'],
    ['plain text', 'no templates', ['text'], null],
    ['empty template', '', [], null],
    ['adjacent expressions', '{{a}}{{b}}', ['expr', 'expr'], null],
    ['invalid expression', 'x {{ 1 + }} y', ['text', 'text'], 'parse_error'],
  ];
  it.each(cases)('%s', (_name, src, parts, code) => {
    const tpl = parseTemplate(src);
    expect(tpl.parts.map((p) => p.kind)).toEqual(parts);
    expect(tpl.diagnostics[0]?.code ?? null).toBe(code);
  });

  it('error positions are absolute within the template', () => {
    const tpl = parseTemplate('line1\n{{ foo bar }}');
    expect(tpl.diagnostics[0]?.start).toEqual({ line: 2, col: 8 });
    expect(tpl.diagnostics[0]?.span).toEqual({ start: 13, end: 16 });
  });
});

const printCases: [string, string][] = [
  ['1+2*3', '1 + 2 * 3'],
  ['(1+2)*3', '(1 + 2) * 3'],
  ['1-(2-3)', '1 - (2 - 3)'],
  ['(1-2)-3', '1 - 2 - 3'],
  ['a or (b or c)', 'a or (b or c)'],
  ['(a and b) or c', 'a and b or c'],
  ['not (a and b)', 'not (a and b)'],
  ['(not a) == b', '(not a) == b'],
  ['(a == b) == c', '(a == b) == c'],
  ['-(a * b)', '-(a * b)'],
  ['"it\'s"', "'it\\'s'"],
  ["'a\\nb'", "'a\\nb'"],
  ["'\\u{1}'", "'\\u{1}'"],
  ['1e21', '1e+21'],
  ['0.0000001', '1e-7'],
  ['(a ? b : c) ? d : e', '(a ? b : c) ? d : e'],
  ['a ? b : (c ? d : e)', 'a ? b : c ? d : e'],
  ['x?.y.z[0]', 'x?.y.z[0]'],
  ['len( x )', 'len(x)'],
  ['[1,2 ,3]', '[1, 2, 3]'],
  ['(-a).b', '(-a).b'],
  ['-(-a)', '--a'],
  ['a.not', 'a.not'],
  ['1.5.x', '1.5.x'],
  ['not not a', 'not not a'],
  ['a and (not b)', 'a and not b'],
  ['(a or b) and c', '(a or b) and c'],
  ['-(not a)', '-(not a)'],
];

describe('printer', () => {
  it.each(printCases)('%j prints as %j and round-trips', (src, expected) => {
    const ast = parseOrThrow(src);
    const printed = print(ast);
    expect(printed).toBe(expected);
    expect(stripSpans(parseOrThrow(printed))).toEqual(stripSpans(ast));
  });

  const countCases: [string, number][] = [
    ['1', 1],
    ['1 + 2', 3],
    ['f(a, b.c)', 4],
    ['[1, 2, 3][0]', 6],
    ['a ? b : -c', 5],
  ];
  it.each(countCases)('countNodes(%j) = %i', (src, count) => {
    expect(countNodes(parseOrThrow(src))).toBe(count);
  });

  it('stripSpans removes every span', () => {
    expect(stripSpans(parseOrThrow('a.b + 1'))).toEqual({
      type: 'binary',
      op: '+',
      left: { type: 'member', object: { type: 'ident', name: 'a' }, property: 'b', optional: false },
      right: { type: 'number', value: 1 },
    });
  });
});
