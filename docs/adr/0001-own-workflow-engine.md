# 0001 Build an own durable workflow engine instead of Temporal, n8n or Inngest

Status: accepted · 2026-10-02

## Context
The product needs long-running business automations: timers of days, human approvals, retries of flaky integrations, joins of parallel branches, and a visual builder whose nodes are typed. The portfolio goal of the project is to show that the team understands durable execution, not only how to configure a product.

## Options
| Option | For | Against |
|---|---|---|
| Temporal | Battle-tested history/replay model, SDK workers, huge feature set | Separate cluster (Cassandra/Postgres + frontend/history/matching services), workflows are code (no visual JSON DAG with type checking), replay determinism constraints leak into product code |
| n8n | Visual builder out of the box | AGPL-ish "fair-code" license, separate data store, weak multi-tenancy, effects not idempotent by design |
| Inngest | Step functions with retries, nice DX | SaaS-first, events and state live outside our Postgres transaction |
| Own engine on Postgres + BullMQ | State lives next to domain data (one transaction), typed DAG model shared by UI and runtime, no new infrastructure | We own correctness: leases, retries, timers, joins, recovery; fewer features (no history replay, no signals, no child workflows) |

## Decision
Own engine: definitions are a JSON DAG validated by `packages/workflow-core`, state in `workflow_runs` / `step_runs`, execution by BullMQ workers, recovery by a leader-elected scheduler. The scope is deliberately small: at-least-once steps with effectively-once effects, timers, waits for events and approvals, `for_each`, error edges.

## Consequences
- Every guarantee needs a failure test (kill -9, duplicate nudges, restart, Redis flush, join race, version pinning, loops, noisy neighbour) — they exist in `packages/core/test/integration`.
- For complex long-lived processes (sagas over many services, child workflows, history replay, workflow versioning with patches) I would use Temporal in production; this engine is right-sized for "business automations inside one product".
