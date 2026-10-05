# 0003 Leases with heartbeat instead of holding a row lock

Status: accepted · 2026-10-02

## Context
Steps can take seconds to minutes (HTTP calls, PDF rendering, AI). If a worker dies, someone else must continue the step.

## Options
- Hold `SELECT … FOR UPDATE` on the step row for the whole execution: automatic release on connection death, but a long transaction per step, pool exhaustion, idle-in-transaction timeouts, and the effect must happen inside the lock.
- Lease: `lease_owner`, `lease_expires_at = now() + 30 s`, heartbeat every 10 s extends it; the scheduler moves expired `running` steps back to `pending`.

## Decision
Leases. The heartbeat also detects lease loss (0 rows updated) and aborts the handler through its `AbortSignal`, so a worker that was partitioned away does not complete a step another worker already re-claimed (completion is guarded by `lease_owner`).

## Consequences
- Recovery latency after `kill -9` ≈ lease TTL + sweep interval (3 s + 0.3 s in the test configuration, 30 s + 5 s by default).
- A step can run twice (the dead worker may have produced its effect) → effects must be idempotent (0004).
- Metric `workflow_lease_expired_total` counts worker deaths; attempt history records `lease_expired` with the dead worker id.
