import fc from 'fast-check';
import { FORBIDDEN_IDENTIFIERS } from '../src/index';
import type { BinaryOp, Node, Span } from '../src/index';

const KEYWORDS = ['and', 'or', 'not', 'in', 'true', 'false', 'null'];
const span: Span = { start: 0, end: 0 };

const word = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/).filter((s) => !FORBIDDEN_IDENTIFIERS.includes(s));
export const identifierArb = word.filter((s) => !KEYWORDS.includes(s));
export const propertyArb = fc.oneof(word, fc.constantFrom(...KEYWORDS));

const char16 = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));
export const unicodeStringArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.string({ unit: char16, maxLength: 12 }),
  fc.constantFrom('', "'", '"', '\\', '{{', '}}', '\n\t\r', '\u0000', '\u{1F600}'),
);

export const numberArb = fc.oneof(
  fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true }).map((v) => v + 0),
  fc.nat({ max: 1000 }),
  fc.constantFrom(0, 1e21, 1e-7, 5e-324, 0.1, 123.456),
);

const BINARY_OPS: BinaryOp[] = ['or', 'and', '==', '!=', '<', '<=', '>', '>=', 'in', '+', '-', '*', '/', '%'];

export function astArb(
  opts: {
    idents?: fc.Arbitrary<string>;
    callees?: fc.Arbitrary<string>;
    props?: fc.Arbitrary<string>;
    strings?: fc.Arbitrary<string>;
  } = {},
): fc.Arbitrary<Node> {
  const idents = opts.idents ?? identifierArb;
  const callees = opts.callees ?? identifierArb;
  const props = opts.props ?? propertyArb;
  const strings = opts.strings ?? unicodeStringArb;
  const leaf: fc.Arbitrary<Node> = fc.oneof(
    numberArb.map((value): Node => ({ type: 'number', value, span })),
    strings.map((value): Node => ({ type: 'string', value, span })),
    fc.boolean().map((value): Node => ({ type: 'bool', value, span })),
    fc.constant<Node>({ type: 'null', span }),
    idents.map((name): Node => ({ type: 'ident', name, span })),
  );
  return fc.letrec<{ node: Node }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'medium', withCrossShrink: true },
      leaf,
      fc.array(tie('node'), { maxLength: 3 }).map((items): Node => ({ type: 'list', items, span })),
      fc
        .tuple(tie('node'), props, fc.boolean())
        .map(([object, property, optional]): Node => ({ type: 'member', object, property, optional, span })),
      fc.tuple(tie('node'), tie('node')).map(([object, index]): Node => ({ type: 'index', object, index, span })),
      fc
        .tuple(callees, fc.array(tie('node'), { maxLength: 3 }))
        .map(([callee, args]): Node => ({ type: 'call', callee, args, span })),
      fc
        .tuple(fc.constantFrom<'-' | 'not'>('-', 'not'), tie('node'))
        .map(([op, operand]): Node => ({ type: 'unary', op, operand, span })),
      fc
        .tuple(fc.constantFrom(...BINARY_OPS), tie('node'), tie('node'))
        .map(([op, left, right]): Node => ({ type: 'binary', op, left, right, span })),
      fc
        .tuple(tie('node'), tie('node'), tie('node'))
        .map(([test, consequent, alternate]): Node => ({ type: 'ternary', test, consequent, alternate, span })),
    ),
  })).node;
}

export const TOKEN_SOUP = [
  '(',
  ')',
  '[',
  ']',
  'a',
  'b',
  'invoice',
  '.',
  '?.',
  '?',
  ':',
  '+',
  '-',
  '*',
  '/',
  '%',
  'not',
  'and',
  'or',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  '1',
  '2.5',
  '1e3',
  "'x'",
  '"y"',
  "'",
  '"',
  '{{',
  '}}',
  '{',
  '}',
  ',',
  'len',
  'now',
  'days',
  'role',
  'secret',
  'user',
  '\\',
  ' ',
  '\n',
  'constructor',
  '__proto__',
  'prototype',
  'true',
  'false',
  'null',
  '=',
  '!',
  '&&',
  '#',
  '\u{1F600}',
  "'\\u{",
  '1e999',
];

export const tokenSoupArb = fc
  .array(fc.constantFrom(...TOKEN_SOUP), { maxLength: 40 })
  .chain((parts) => fc.constantFrom(parts.join(''), parts.join(' ')));

export const randomSourceArb = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 120 }),
  fc.string({ unit: char16, maxLength: 120 }),
  tokenSoupArb,
);
