# 0009 Realtime through the project 03 engine with a tenant ACL hook

Status: accepted · 2026-10-02

## Context
Kanban moves, notifications, approvals and test-run statuses must reach browsers live. Project 03 already implements ordered durable channels, presence, resume and ticket auth.

## Decision
`apps/realtime` runs `RealtimeServer` from `@ashamrai/realtime-server` (linked from project 03, unmodified) with a custom `Authorizer`: `room:t.<tenantId>.*` channels are only accessible when the JWT claim `tid` matches, clients can subscribe, use presence and ephemeral messages but not publish durable messages. The API issues short-lived JWTs and exchanges them for one-time tickets (`POST /v1/realtime/ticket`). The browser uses `@ashamrai/realtime-client` (packed tarball). Domain events reach the channels through the outbox consumer.

## Consequences
- If the realtime server is down, the API returns 503 for tickets and the SPA falls back to polling; notifications additionally have an SSE endpoint fed from Redis pub/sub.
- Server-side publish is one HTTP request per event; with many events per second this should become a Redis-streams integration instead.
