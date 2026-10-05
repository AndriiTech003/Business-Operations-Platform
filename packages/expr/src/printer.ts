import type { BinaryOp, Node } from './types';

const P_TERNARY = 1;
const P_OR = 2;
const P_AND = 3;
const P_NOT = 4;
const P_COMPARE = 5;
const P_SUM = 6;
const P_PRODUCT = 7;
const P_UNARY = 8;
const P_POSTFIX = 9;
const P_PRIMARY = 10;

function binaryPrec(op: BinaryOp): number {
  switch (op) {
    case 'or':
      return P_OR;
    case 'and':
      return P_AND;
    case '+':
    case '-':
      return P_SUM;
    case '*':
    case '/':
    case '%':
      return P_PRODUCT;
    default:
      return P_COMPARE;
  }
}

function precedence(n: Node): number {
  switch (n.type) {
    case 'ternary':
      return P_TERNARY;
    case 'binary':
      return binaryPrec(n.op);
    case 'unary':
      return n.op === 'not' ? P_NOT : P_UNARY;
    case 'member':
    case 'index':
    case 'call':
      return P_POSTFIX;
    case 'number':
      return n.value < 0 || Object.is(n.value, -0) ? P_UNARY : P_PRIMARY;
    default:
      return P_PRIMARY;
  }
}

export function printNumber(value: number): string {
  if (Number.isNaN(value)) return '(0 / 0)';
  if (!Number.isFinite(value)) return value > 0 ? '1e999' : '-1e999';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

export function printString(value: string): string {
  let out = "'";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "'") out += "\\'";
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return `${out}'`;
}

function wrap(n: Node, min: number): string {
  const s = print(n);
  return precedence(n) < min ? `(${s})` : s;
}

export function print(ast: Node): string {
  switch (ast.type) {
    case 'number':
      return printNumber(ast.value);
    case 'string':
      return printString(ast.value);
    case 'bool':
      return ast.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'ident':
      return ast.name;
    case 'list':
      return `[${ast.items.map((i) => print(i)).join(', ')}]`;
    case 'member':
      return `${wrap(ast.object, P_POSTFIX)}${ast.optional ? '?.' : '.'}${ast.property}`;
    case 'index':
      return `${wrap(ast.object, P_POSTFIX)}[${print(ast.index)}]`;
    case 'call':
      return `${ast.callee}(${ast.args.map((a) => print(a)).join(', ')})`;
    case 'unary':
      return ast.op === 'not' ? `not ${wrap(ast.operand, P_NOT)}` : `-${wrap(ast.operand, P_UNARY)}`;
    case 'binary': {
      const p = binaryPrec(ast.op);
      const leftMin = p === P_COMPARE ? P_SUM : p;
      const rightMin = p === P_COMPARE ? P_SUM : p + 1;
      const rightPrec = p === P_AND ? P_NOT : rightMin;
      return `${wrap(ast.left, leftMin)} ${ast.op} ${wrap(ast.right, rightPrec)}`;
    }
    case 'ternary':
      return `${wrap(ast.test, P_OR)} ? ${print(ast.consequent)} : ${print(ast.alternate)}`;
  }
}
