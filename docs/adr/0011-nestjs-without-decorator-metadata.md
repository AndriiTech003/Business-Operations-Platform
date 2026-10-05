# 0011 NestJS without emitted decorator metadata; zod contracts shared with the SPA

Status: accepted · 2026-10-02

## Context
The monorepo builds with tsup/esbuild (fast, ESM), which does not emit `design:paramtypes`. NestJS DI and class-validator rely on it.

## Decision
- Explicit `@Inject(CORE)` for the single dependency of every controller: the domain lives in `@bop/core` (plain classes usable from API, worker, scheduler, seed and tests), Nest is only the HTTP layer.
- Validation with zod schemas from `@bop/contracts` (`ZBody`, `ZQuery` pipes). The same schemas drive the SPA forms and the OpenAPI document.
- `API_ROUTES` in contracts is the single route table: the scope guard derives the required scope from it, OpenAPI is generated from it, and a test fails if a controller route is missing from it (or vice versa).

## Consequences
- No reflection magic; adding a route requires adding it to the table (enforced).
- Nest features that depend on metadata (Swagger decorators, class-transformer) are not used.
