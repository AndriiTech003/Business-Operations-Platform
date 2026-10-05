# 0008 Runs work on a snapshot of the trigger record

Status: accepted · 2026-10-02

## Context
Expressions read `invoice.status`, `deal.owner`, … A run may wait for days between steps.

## Decision
When a run starts, the trigger record with one level of relations is loaded and stored in `trigger_payload.record`. Every step evaluates against that snapshot plus `steps.X.output`. Steps that change data (`update_record`) re-read the current row through the domain service and fail-retry on version conflicts (412 is retryable).

## Alternatives
Re-loading the record before every step: fresher data, but the same step evaluates differently on retry, and replay can no longer explain why a branch was taken.

## Consequences
- Deterministic retries and a faithful replay view.
- A workflow that must react to later changes uses `wait_for_event` (its output contains the event payload) or a fresh trigger.
