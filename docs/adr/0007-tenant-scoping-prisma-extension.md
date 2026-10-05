# 0007 Tenant scoping with a Prisma client extension (vs Postgres RLS in project 01)

Status: accepted · 2026-10-02

## Context
Every tenant-owned table has `tenant_id`. A query without a tenant must fail instead of returning other tenants' data.

## Options
| | Prisma extension (this project) | Row-Level Security (project 01, Drizzle) |
|---|---|---|
| Enforcement point | Application, every Prisma operation of every tenant model | Database, every statement |
| Raw SQL | Bypasses it → must be forbidden | Still protected |
| Portability / debuggability | Plain Prisma, easy to test, no session settings | Needs `SET app.tenant_id` per transaction and pooled-connection discipline |
| Cost | Merges `tenantId` into `where`/`data` | Planner adds the policy predicate |

## Decision
`tenantExtension` wraps all operations of the 30 tenant models: reads/updates/deletes get `tenantId` merged into `where` (a conflicting `tenantId` becomes an impossible `AND`), creates get it stamped (a different value throws `CrossTenantWriteError`), unknown operations fail closed, nested relation writes are impossible (no Prisma relations are declared). The tenant comes from `AsyncLocalStorage`; `runInContext` also starts lazy `PrismaPromise`s inside the context (a real bug found by the test suite).

Raw SQL (`$queryRaw*`, `$executeRaw*`, `Prisma.sql`, importing `pg`) is forbidden by ESLint everywhere except `packages/core/src/raw/*` (reports, search, condition scanner, custom-field sort and index DDL). Every method there takes `tenantId` explicitly and has a tenant-filter integration test.

## Consequences
- 1053 generated tests: every model × every operation fails without context and never reads/changes the other tenant's rows.
- This is defence in the application layer only; a production system with many raw queries would add RLS as a second layer.
