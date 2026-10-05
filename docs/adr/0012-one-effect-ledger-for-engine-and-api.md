# 0012 One effect ledger for engine steps and API Idempotency-Key writes

Status: accepted · 2026-10-05

## Context
Two idempotency mechanisms existed side by side: workflow steps recorded their side effects in `effect_log` (0004), while HTTP requests with an `Idempotency-Key` header (used by `ops-mcp` and therefore by the AI agent of project 06) were stored only in `idempotency_records` (the cached response for replays). A consumer that wanted to prove "this write happened exactly once" had to know which of the two tables to look at, and the agent's tests asserted on `idempotency_records` instead of the ledger the spec describes.

## Decision
- `effect_log` is the single ledger of effects. Its primary key is `(tenant_id, origin, idempotency_key)`; `origin` is `engine` (workflow steps) or `api` (HTTP writes with an `Idempotency-Key`).
- Engine rows keep their format (`run_id:node_id:iteration`, `effect` = node type). Engine lookups only read `origin = 'engine'`, so a client-chosen API key can never shadow a step key.
- API rows use the client's key verbatim, `effect` = the operation scope (`task.create`, `email.draft`, `email.send:<draftId>`, `invoice.create`, `invoice.send:<id>`, `invoice.payment:<id>`, `invoice.void:<id>`, `note.create`, `deal.update:<id>`, `deal.move:<id>`), `request_hash` = SHA-256 of the request body, `result` = `{ status, ref: { id, number?, status? } }`.
- `idempotency_records` stays as the response cache for replays (status code + full body). Both rows are written in one transaction after the operation succeeded.
- Contract for clients (documented in IMPLEMENTATION_NOTES): a key identifies one effect per tenant. The same key with the same body replays the first response (`Idempotent-Replayed: true`). The same key with a different body, or with a different operation, is `422 idempotency_mismatch`. Concurrent requests with the same key are serialised by a Redis lock; one that cannot get the lock within 5 s gets `409 idempotency_in_progress`. Failed operations (4xx/5xx) are not recorded, so a corrected retry with the same key is allowed. `dryRun` requests never touch either table.
- "Exactly one effect" is checked in one place: `SELECT origin, effect FROM effect_log WHERE tenant_id = $1 AND idempotency_key = $2` returns one row.

## Consequences
- Tests: `apps/api` (invoice create replay + ledger row + cross-operation reuse → 422), `apps/ops-mcp` (create_task, draft_email and send_email keys → exactly one `api` row each), `packages/core` operator test (retried `ai_step` → one `engine` row), tenancy test covers the new composite key.
- Remaining window: the API row is written after the domain transaction commits. A crash between the two commits lets a retry execute the operation again; the window is milliseconds and is the same as before this change. Workflow steps do not have this window because their effect and ledger row share a transaction (0004).
