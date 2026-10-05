# 0002 Postgres is the source of truth; BullMQ jobs are only nudges

Status: accepted · 2026-10-02

## Context
A step must not be lost when a worker dies or Redis loses data, and a duplicate delivery must not run a step twice. Domain changes made by a step (task created, deal updated) live in Postgres.

## Decision
- `step_runs` holds the full state machine (`pending → running → waiting → succeeded/failed/skipped/cancelled`), attempt counter, lease, `scheduled_for`, wait descriptor, attempt history.
- A BullMQ job only says "look at step X". The worker claims atomically with a conditional `UPDATE … WHERE status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now()) RETURNING *` (Prisma `updateManyAndReturn`). Zero rows means a duplicate or an early job: ack and exit.
- Advancing a run (next steps, joins, run completion) happens in one transaction that first locks the run row (`UPDATE workflow_runs SET lock_version = lock_version + 1 … RETURNING *`), so concurrent completions of sibling branches are serialized without `SELECT … FOR UPDATE` (not available in Prisma).
- New nudges are enqueued only after commit. If that enqueue is lost, the scheduler re-nudges pending steps older than `LOST_NUDGE_AFTER_MS`.

## Alternatives
State inside BullMQ (job data/progress): simple, but not transactional with domain writes and lost on `FLUSHDB`.

## Consequences
- Proven by tests: 10 identical nudges → handler runs once; `FLUSHDB` during 100 in-flight runs → all complete; join race → join step created once.
- Cost: every step needs several Postgres round-trips (11.6 statements per step after optimisation, see 0010). Redis is a performance optimisation, Postgres throughput is the ceiling.
