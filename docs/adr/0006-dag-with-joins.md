# 0006 A DAG with joins (dead-path elimination) instead of a linear list of steps

Status: accepted · 2026-10-02

## Context
Real automations branch ("big invoice → notify and create a task, small → just remind") and merge again.

## Decision
Definitions are DAGs with labelled edges (`true/false`, `case:x/default`, `approved/rejected/timeout`, `next/error`, `item/done`). A node with several incoming edges is a join. `computeAdvance` (pure, in `workflow-core`) resolves each incoming edge as activated, dead or unresolved: a node is created when all incoming edges are resolved and at least one is activated; it is skipped when all are dead, and skipping propagates. `for_each` bodies are the nodes reachable through `item` edges but not through `done` edges; each iteration has its own `iteration` number in `step_runs`.

## Consequences
- The join is created exactly once even when both branches finish at the same moment: advancing is serialized by the run-row lock and `(run_id, node_id, iteration)` is unique.
- Skipped steps are stored, so run replay can show which path was not taken.
- Cycles are rejected at publish; loops are expressed with `for_each`.
