# 0005 Own expression language instead of JSONata, JSON Logic or JS in a sandbox

Status: accepted · 2026-10-02

## Context
Users write conditions, templates and field values in the builder: `invoice.totalCents > 100000`, `now() + days(1)`, `{{ formatMoney(invoice.totalCents) }}`. The same expressions run in the worker, are type-checked at publish, drive autocomplete in the editor, and some must run as SQL in the `record_condition` scanner.

## Options
| Option | Problem |
|---|---|
| JS in `isolated-vm` / `vm` | Security surface (escapes, CPU/memory limits), no static types, no SQL compilation, native module |
| JSONata | Powerful but untyped; error positions and autocomplete are hard; no SQL compilation |
| JSON Logic | Unreadable for users, no templates, no types |
| Own language | We own lexer, Pratt parser, type checker, evaluator, printer, SQL compiler, completion |

## Decision
`@ashamrai/expr`: zero dependencies, ~15 KB brotli. Types include `date`, `duration`, `money` with currency checks; the type context is built from the trigger entity, tenant custom fields, one level of relations and outputs of dominating steps. No loops, AST ≤ 500 nodes, expression ≤ 2000 chars, strings ≤ 10 000 chars; `constructor`, `__proto__`, `prototype` are forbidden identifiers; evaluation only reads own properties of plain frozen data and never calls functions found in data.

## Consequences
- 582 table cases, fast-check print→parse round trip (1500 runs), fuzzing (2000 runs per entry point), 63 SQL-vs-in-memory equivalence tests on Postgres.
- Null semantics had to be designed explicitly so that SQL (`IS DISTINCT FROM`, `COALESCE((a < b), FALSE)`) and the evaluator agree.
- The language is small on purpose; anything bigger belongs in an `http_request` or a code step, not in expressions.
