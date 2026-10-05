# 0004 Idempotency key without the attempt number, plus effect_log

Status: accepted · 2026-10-02

## Context
Steps are executed at least once (0003). Side effects must happen effectively once: one email, one task, one invoice draft, one HTTP call per step.

## Decision
- Every step gets `idempotency_key = run_id:node_id:iteration` — without the attempt. A retry after a crash uses the same key; a key with the attempt would make the retry a "new" effect.
- `send_email` inserts the `email_messages` row (the mail outbox) and the `effect_log` row in one transaction. The retry finds the `effect_log` row and returns the stored result.
- `create_task` stores the key in a unique `tasks.idempotency_key` column; `add_note` stores it in the unique `activities.source_key`; `notify` uses a unique `notifications.source_key`; `create_invoice` writes `effect_log` inside the invoice transaction; `http_request` sends `Idempotency-Key` and caches the response in `effect_log`.
- `update_record` is idempotent by value (setting the same fields twice converges) and records the result after success.

## Consequences
- Test: `kill -9` during `send_email` (after the effect was committed) → second attempt by another worker → exactly one email in Mailpit, one `email_messages` row.
- SMTP itself is at-least-once: if a dispatcher dies after the SMTP server accepted a message but before it was marked sent, the message is sent again after the dispatch lease. The `Message-ID` is the email row id so receivers can deduplicate. Documented as a known limitation.
