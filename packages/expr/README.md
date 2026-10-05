# @ashamrai/expr

A small, safe, statically typed expression language for business workflows: conditions, computed values and
`{{ }}` string templates. It ships the whole toolchain — lexer, Pratt parser, AST, type checker with
"did you mean" suggestions, tree-walking evaluator, canonical printer, editor autocompletion, and a compiler
that turns a subset of conditions into parameterized PostgreSQL.

- **No `eval`, no `new Function`, no `vm`/`isolated-vm`.** Expressions are interpreted over plain data.
- **Always terminates.** There are no loops, no user-defined functions and no recursion; size limits are enforced.
- **Typed.** Expressions are checked against a type context before they run, with precise `line:col` diagnostics.
- **Zero runtime dependencies.** ESM + CJS builds, ~15 kB minified and brotlied.

```ts
import { T, analyze, evaluateExpression, hydrate, renderTemplate } from '@ashamrai/expr';

const invoiceType = T.object(
  {
    number: T.string,
    status: T.string,
    totalCents: T.number,
    currency: T.string,
    dueDate: T.date,
    company: T.object({ name: T.string, owner: T.user }, 'Company'),
  },
  'Invoice',
);

const ctx = { vars: { invoice: invoiceType } };
const condition = "invoice.status == 'sent' and invoice.dueDate < now() - days(1)";

const { diagnostics } = analyze(condition, ctx, { expected: T.bool });
// [] — or e.g. "Unknown field 'staus' on Invoice. Did you mean 'status'?" at 1:9

const invoice = hydrate(
  { number: 'INV-7', status: 'sent', totalCents: 123456, currency: 'EUR', dueDate: '2024-05-01T00:00:00Z',
    company: { name: 'Acme', owner: { id: 'u1', name: 'Olga', email: 'olga@example.com' } } },
  invoiceType,
);

evaluateExpression(condition, { vars: { invoice } }); // true
renderTemplate('Invoice {{ invoice.number }}: {{ formatMoney(invoice.totalCents, invoice.currency) }}', {
  vars: { invoice },
}); // 'Invoice INV-7: €1,234.56'
```

## Grammar

```text
expr     := ternary
ternary  := or ('?' expr ':' expr)?
or       := and ('or' and)*
and      := not ('and' not)*
not      := 'not' not | compare
compare  := sum (('=='|'!='|'<'|'<='|'>'|'>='|'in') sum)?
sum      := product (('+'|'-') product)*
product  := unary (('*'|'/'|'%') unary)*
unary    := '-' unary | postfix
postfix  := primary ('.' ident | '?.' ident | '[' expr ']' | '(' args ')')*
primary  := number | string | 'true' | 'false' | 'null' | ident | '(' expr ')' | '[' list ']'
```

- **Numbers:** `12`, `1.5`, `1e3`, `2.5e-3`, `1E+21`. Literals are non-negative; `-` is a unary operator.
  Literals that overflow to infinity are rejected.
- **Strings:** single or double quotes, escapes `\n \t \r \\ \' \"` and `\u{1F600}` (1–6 hex digits).
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`. Keywords: `and or not in true false null`.
  After `.` or `?.` any identifier-like word (keywords included) is a field name: `x.in`, `a?.not`.
- **Comparisons do not chain:** `a < b < c` is a syntax error; use parentheses.
- `not` binds looser than comparisons (`not a == b` is `not (a == b)`); it must be parenthesized as an operand
  of comparison or arithmetic (`a == (not b)`).
- **Calls** are allowed only on a bare identifier naming a whitelisted function: `len(x)`.
  Anything else (`a.b()`, `f(x)(y)`, `(len)(x)`) is a `not_callable` error.
- `constructor`, `__proto__` and `prototype` are rejected both as identifiers and as field names
  (`forbidden_identifier`).

## Types

| Type | Runtime value | Notes |
|---|---|---|
| `number` | `number` | IEEE double; results must be finite |
| `string` | `string` | |
| `bool` | `boolean` | |
| `null` | `null` | `undefined` in data is treated as `null` |
| `date` | `Date` | instants, formatted in UTC |
| `duration` | `Duration { ms }` | |
| `money` | `Money { cents, currency }` | integer minor units + ISO currency |
| `list<T>` | frozen array | |
| `object{...}` | frozen plain object | named objects print as their name, e.g. `Invoice` |
| `user` | `{ id, name, email }` | all fields `string` |
| `T?` | value or `null` | `T.nullable(T)` |
| `any` | anything | member/index access on `any` yields `any` |

`isAssignable(from, to)` is structural: objects are assignable when every target field exists and is assignable,
lists are covariant, `null` and `T` are assignable to `T?`, `any` is assignable both ways, and a `user`
is assignable to any object type whose fields are a subset of `id`, `name`, `email` (and vice versa).

### Operators

| Expression | Result |
|---|---|
| `number + - * / % number` | `number` |
| `string + string` | `string` (`string + number` is a type error) |
| `date - date` | `duration` |
| `date ± duration`, `duration + date` | `date` |
| `duration ± duration` | `duration` |
| `duration * number`, `number * duration`, `duration / number` | `duration` |
| `money ± money` | `money` (same currency, checked at runtime → `currency_mismatch`) |
| `money * number`, `number * money`, `money / number` | `money` (rounded to the nearest minor unit) |
| `-number`, `-duration`, `-money` | same type |
| `< <= > >=` | `number`, `string`, `date`, `duration`, `money` with the same type; `money` also with `number` (minor units) |
| `== !=` | any two compatible types, or either side `null`; deep equality for lists and objects; `money == number` compares minor units |
| `x in list<T>` | membership with `==` semantics |
| `s in string` | substring test |
| `and`, `or`, `not`, `?:` test | require `bool` (`bool?` allowed) |

**Null semantics** (identical in the evaluator and in compiled SQL):

- In `and`/`or`/`not` and the ternary test, `null` counts as `false`. `and`/`or` short-circuit and always return a `bool`.
- Ordering comparisons with a `null` operand are `false` (so `not (x > 5)` is `true` when `x` is `null`).
- `null == null` is `true`; `null == 5` is `false`.
- Arithmetic with a `null` operand yields `null` (the static type becomes nullable).
- `x in null` is `false`.
- Ternary branches must have the same type; `cond ? 1 : null` has type `number?`.

**Member and index access:**

- `a.b` on a nullable object type type-checks with a **warning** `nullable_access`, has a nullable result,
  and throws `null_access` at runtime when `a` is `null`. `a?.b` returns `null` instead, without a warning.
  `?.` does not short-circuit the rest of the chain: `a?.b.c` warns on `.c`.
- `list[number]` has type `T?`; out-of-range, negative or non-integer indexes return `null`.
- `object['literal']` has the field's type; `object[dynamicString]` has type `any`.
- Unknown fields and identifiers are errors with a Levenshtein-based suggestion:
  `Unknown field 'nubmer' on Invoice. Did you mean 'number'?`

## Functions

Only these functions exist. Unknown names are `unknown_function` errors (with suggestions); wrong argument
counts are `arity`; wrong argument types are `type_mismatch`.

| Signature | Description |
|---|---|
| `now(): date` | Current date and time; uses `env.now` when provided. |
| `days(n: number): duration` | A duration of n days (24 hours each). |
| `hours(n: number): duration` | A duration of n hours. |
| `date(s: string): date` | Parses ISO 8601 (`2024-05-01`, `2024-05-01T10:00:00+02:00`); no offset means UTC. |
| `formatMoney(cents: money\|number, currency?: string): string` | `$1,234.50`; currency is required when the amount is a number. |
| `formatDate(d: date, format: string): string` | UTC formatting with tokens `YYYY MM MMM DD D HH mm ss`. |
| `lower(s)`, `upper(s)`, `trim(s)` | String case and whitespace helpers. |
| `contains(haystack: string\|list<T>, needle): bool` | Substring or list membership; `false` for `null`. |
| `startsWith(s: string, prefix: string): bool` | `false` for `null`. |
| `len(x: string\|list<T>): number` | Characters (Unicode code points) or list items. |
| `coalesce(a, b, ...): T` | First non-null argument (arguments are evaluated lazily). |
| `round(n: number, digits?: number): number` | Half away from zero; `digits` is an integer 0–15. |
| `min(...)`, `max(...)` | Numbers, dates, durations or money (same type, same currency). |
| `role(name: string): list<user>` | Users with a role, via `env.host.role`. Requires a string literal. |
| `user(id: string): user?` | Looks up a user, via `env.host.user`. |
| `secret(name: string): string` | Via `env.host.secret`. Requires a string literal and `ctx.allowSecret`. |

Except `coalesce`, `contains`, `startsWith`, `role` and `secret`, functions propagate `null`: if any argument is
`null` the result is `null` and the static result type is nullable. Host functions that are not provided throw
`host_unavailable`; exceptions thrown by host functions become `host_error`.
`FUNCTIONS` exports `{ name, signature, description }` for every function.

## Templates

```text
Invoice {{ invoice.number }} is overdue ({{ formatMoney(invoice.totalCents, invoice.currency) }})
```

- Text with `{{ expr }}` parts; each part is a full expression and is type-checked.
- `}}` inside a string literal does not close the part: `{{ '}}' }}` renders `}}`.
- An unclosed `{{` is an `unclosed_template` diagnostic; an empty `{{ }}` is a `parse_error`.
- Spans and positions are absolute offsets in the template source.
- Values are formatted with `formatValue`: `null` → empty string; dates at midnight UTC → `2024-05-01`,
  other dates → full ISO; money → `formatMoney`; durations → `3d 4h`, `15m`, `500ms`; lists → items joined
  with `, `; user-like objects → their `name`; other objects → JSON.

## Safety guarantees

- No code generation of any kind; the evaluator walks the AST and only knows the operators above.
- Variables are read only from **own data properties** of `env.vars`. Fields are read only from own enumerable
  data properties of plain objects (prototype `Object.prototype` or `null`) and from array indexes.
  Class instances, `Map`s, inherited properties, `length` and accessor properties are never read,
  so getters are never triggered.
- Function values found in the data are never invoked: reading one throws `invalid_value`.
- `constructor`, `__proto__` and `prototype` are rejected by the parser, by the checker for literal keys,
  and at runtime for dynamic string keys (`forbidden_access`).
- `hydrate` produces deeply frozen copies and drops forbidden keys; list literals are frozen.
- Evaluation can only fail with an `EvalError` (a subclass of `ExprError`) that carries a `code` and the `span`
  of the failing node.
- Proxies are out of scope: pass hydrated data (`hydrate`) rather than arbitrary host objects.

## Limits

| Limit | Default | Enforced |
|---|---|---|
| `maxExpressionLength` | 2000 | parse → `too_long` (per `{{ }}` part in templates) |
| `maxAstNodes` | 500 | parse → `too_many_nodes`; evaluate → `EvalError` |
| `maxStringLength` | 10000 | runtime string results (concatenation, functions, rendered templates) → `string_too_long`; template source → `too_long` |
| `maxListLength` | 1000 | list literals → `list_too_long` (parse and runtime) |

Nesting depth is capped at 200 (`too_deep`). Override limits with `parse(src, limits)`,
`parseTemplate(src, limits)` or `env.limits`.

## SQL compilation

`compileToSql(ast, { resolveField, now, paramOffset })` compiles conditions for scanning records in PostgreSQL:

- comparisons `== != < <= > >=`, `x in [literal, ...]`, `and`, `or`, `not`, parentheses;
- literals (number, string, bool, null) and unary minus on number literals;
- fields resolved by `resolveField(path)`, e.g. `['invoice', 'dueDate']` → `{ sql: 't."due_date"', type: T.date }`
  or `['invoice', 'custom', 'region']` → `{ sql: "(t.\"custom\"->>'region')", type: T.string }`;
- `now()`, `days(n)` and `hours(n)` with literal numbers, `date ± duration`.

Values are positional parameters starting at `$(paramOffset + 1)`: numbers as `$n::numeric`, strings as `$n::text`,
`now()` as `$n::timestamptz` (from `opts.now`), durations as `($n::float8 * INTERVAL '1 millisecond')`.
Money fields are compared as integer minor units.

The SQL has the same semantics as the evaluator, including nulls: `==`/`!=` compile to
`IS NOT DISTINCT FROM`/`IS DISTINCT FROM`, ordering comparisons to `COALESCE((a < b), FALSE)`, string ordering uses
`COLLATE "C"` (code point order), and bool fields used as conditions compile to `COALESCE(field, FALSE)`.
The test suite checks this against a real PostgreSQL database with hand-written and property-generated conditions.

Anything else (arithmetic on numbers, function calls such as `len`, ternaries, money-to-money comparisons,
duration comparisons, `in` with a non-literal list) returns
`{ ok: false, diagnostics: [{ code: 'sql_unsupported', message: 'condition too complex for scanning', span }] }`
with the span of the offending node.

## API

| Export | Purpose |
|---|---|
| `tokenize(src, { tolerant })` | Tokens with spans; tolerant mode never throws and emits `error` tokens. |
| `tokenizeTemplate(src)` | Tolerant template tokens: `text`, `template-open`, expression tokens, `template-close`. |
| `parse(src, limits?)` | `{ ast, diagnostics }`; never throws. |
| `parseOrThrow(src)` | AST or `ExprError`. |
| `parseTemplate(src, limits?)` | `{ parts, diagnostics }` with absolute spans. |
| `check(ast, ctx, src?)` | `{ type, diagnostics }`; `src` is used for `line:col`. |
| `analyze(src, ctx, { template, expected })` | Parse + check + expected-type check. When `expected` is `bool`, `bool?` is accepted (null counts as false). |
| `evaluate(ast, env)`, `evaluateExpression(src, env)` | Run an expression. |
| `renderTemplate(srcOrParsed, env)` | Render a template to a string. |
| `print(ast)` | Canonical source with minimal parentheses; `parse(print(ast))` reproduces the AST. |
| `stripSpans(ast)`, `countNodes(ast)` | AST utilities. |
| `hydrate(json, type)`, `toJSON(value)`, `formatValue(value)` | Data conversion: JSON ⇄ runtime values. |
| `collectHostCalls(astOrTemplate)` | Literal arguments of `role()`, `user()`, `secret()` and whether `user()` is dynamic. |
| `collectPaths(astOrTemplate)` | Field paths such as `['steps', 'remind', 'output', 'messageId']`. |
| `compileToSql(ast, opts)` | See above. |
| `complete(src, offset, ctx, { template })` | Editor completions: fields after `a.`/`a?.`, otherwise variables, functions and keywords. Never throws. |
| `T`, `typeToString`, `isAssignable` | Type constructors and helpers. |
| `Money`, `Duration`, `ExprError`, `EvalError` | Runtime classes. |
| `DEFAULT_LIMITS`, `FORBIDDEN_IDENTIFIERS`, `FUNCTIONS`, `offsetToPosition` | Constants and helpers. |

`hydrate(json, type)` converts JSON to runtime values: dates from ISO strings or epoch milliseconds,
durations from milliseconds, money from minor units (currency from the sibling `currency` string field of the
enclosing object, falling back to `USD`) or from `{ cents, currency }`; numeric strings are accepted for numbers
and money (handy for PostgreSQL `numeric`/`int8`). Unknown object fields are kept as frozen copies.

### Diagnostic codes

- Syntax: `parse_error`, `unexpected_char`, `unterminated_string`, `invalid_escape`, `invalid_number`,
  `not_callable`, `forbidden_identifier`, `unclosed_template`, `too_long`, `too_many_nodes`, `too_deep`, `list_too_long`.
- Types: `unknown_identifier`, `unknown_field`, `unknown_function`, `type_mismatch`, `arity`, `literal_required`,
  `secret_not_allowed`, `not_an_object`, `not_indexable`, `null_access`, `forbidden_access`,
  `nullable_access` (warning).
- Runtime (`EvalError`): `division_by_zero`, `null_access`, `type_error`, `currency_mismatch`, `invalid_currency`,
  `invalid_date`, `invalid_number`, `invalid_argument`, `invalid_value`, `forbidden_access`, `string_too_long`,
  `list_too_long`, `host_unavailable`, `host_error`, `unknown_identifier`, `unknown_function`, `arity`, `too_deep`.
- SQL: `sql_unsupported`.

## License

MIT
