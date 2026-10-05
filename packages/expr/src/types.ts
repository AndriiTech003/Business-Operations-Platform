export interface Span {
  start: number;
  end: number;
}

export interface Position {
  line: number;
  col: number;
}

export type BinaryOp = 'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | '+' | '-' | '*' | '/' | '%';
export type UnaryOp = '-' | 'not';

export type Node =
  | { type: 'number'; value: number; span: Span }
  | { type: 'string'; value: string; span: Span }
  | { type: 'bool'; value: boolean; span: Span }
  | { type: 'null'; span: Span }
  | { type: 'ident'; name: string; span: Span }
  | { type: 'list'; items: Node[]; span: Span }
  | { type: 'member'; object: Node; property: string; optional: boolean; span: Span }
  | { type: 'index'; object: Node; index: Node; span: Span }
  | { type: 'call'; callee: string; args: Node[]; span: Span }
  | { type: 'unary'; op: UnaryOp; operand: Node; span: Span }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; span: Span }
  | { type: 'ternary'; test: Node; consequent: Node; alternate: Node; span: Span };

export type NodeType = Node['type'];

export type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'keyword'
  | 'operator'
  | 'punct'
  | 'template-open'
  | 'template-close'
  | 'text'
  | 'error'
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  span: Span;
}

export type Type =
  | { kind: 'number' }
  | { kind: 'string' }
  | { kind: 'bool' }
  | { kind: 'null' }
  | { kind: 'date' }
  | { kind: 'duration' }
  | { kind: 'money' }
  | { kind: 'user' }
  | { kind: 'any' }
  | { kind: 'list'; of: Type }
  | { kind: 'object'; name?: string; fields: Record<string, FieldInfo> }
  | { kind: 'nullable'; of: Type };

export interface FieldInfo {
  type: Type;
  label?: string;
  description?: string;
  custom?: boolean;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  span: Span;
  start: Position;
  end: Position;
}

export interface TypeContext {
  vars: Record<string, Type>;
  allowSecret?: boolean;
}

export interface CheckResult {
  type: Type;
  diagnostics: Diagnostic[];
}

export interface Limits {
  maxExpressionLength: number;
  maxAstNodes: number;
  maxStringLength: number;
  maxListLength: number;
}

export interface UserValue {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface HostFunctions {
  role?(name: string): readonly UserValue[];
  user?(id: string): UserValue | null;
  secret?(name: string): string;
}

export interface EvalEnv {
  vars: Record<string, unknown>;
  now?: () => Date;
  host?: HostFunctions;
  limits?: Partial<Limits>;
}

export type TemplatePart =
  { kind: 'text'; value: string; span: Span } | { kind: 'expr'; source: string; ast: Node; span: Span };

export interface ParsedTemplate {
  parts: TemplatePart[];
  diagnostics: Diagnostic[];
}

export interface ParseResult {
  ast: Node | null;
  diagnostics: Diagnostic[];
}

export interface AnalyzeOptions {
  template?: boolean;
  expected?: Type;
}

export interface AnalyzeResult {
  ast: Node | null;
  template: ParsedTemplate | null;
  type: Type;
  diagnostics: Diagnostic[];
}

export interface HostCalls {
  roles: string[];
  users: string[];
  secrets: string[];
  dynamicUsers: boolean;
}

export interface SqlField {
  sql: string;
  type: Type;
}

export interface SqlCompileOptions {
  resolveField(path: string[]): SqlField | null;
  now: Date;
  paramOffset?: number;
}

export type SqlCompileResult = { ok: true; sql: string; params: unknown[] } | { ok: false; diagnostics: Diagnostic[] };

export type CompletionKind = 'field' | 'function' | 'variable' | 'keyword';

export interface Completion {
  label: string;
  kind: CompletionKind;
  type?: string;
  detail?: string;
  apply?: string;
}

export interface CompletionResult {
  from: number;
  to: number;
  options: Completion[];
}

export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
}
