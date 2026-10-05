# ROADMAP · Business Operations Platform (7–9 недель)

## M0 — Фундамент (0.5 недели)
- [ ] Монорепо (pnpm + Turborepo), compose: Postgres, Redis, Mailpit, MinIO
- [ ] NestJS-каркас, Prisma + tenant extension + тест на все модели, problem+json, OTel, pino
- [ ] Vite SPA-каркас, auth (JWT + refresh cookie), layout, ⌘K-заглушка
- [ ] CI: lint, typecheck, unit, integration (Testcontainers), build

## M1 — CRM-ядро (1.5 недели)
- [ ] Companies, contacts, activity timeline, comments с @mentions, notifications
- [ ] Кастомные поля (определения, динамическая zod-валидация, UI-конструктор, input-компоненты)
- [ ] DataTable (виртуализация, фильтры, сохранённые представления в URL), страница записи
- [ ] CSV-импорт (BullMQ, прогресс, отчёт ошибок), слияние дубликатов
- [ ] Глобальный поиск (FTS + trigram)
- [ ] Audit log с `actorType`

## M2 — Сделки, счета, задачи (1.5 недели)
- [ ] Воронки и стадии, канбан (dnd-kit, дробный индекс, optimistic), forecast
- [ ] Счета: позиции, налоги, статусы, PDF (Chromium-воркер), отправка, публичная ссылка, платежи, overdue
- [ ] Задачи: «Мои задачи», напоминания
- [ ] Outbox + доменные события в BullMQ
- [ ] Realtime (проект 03 или временный ws-gateway): канбан, уведомления, presence
- [ ] Отчёты: воронка, выручка, AR aging

## M3 — Язык выражений (1 неделя)
- [ ] `packages/expr`: lexer, Pratt-парсер, AST-печать, type checker, evaluator, шаблоны `{{ }}`, whitelist функций, лимиты
- [ ] Компиляция подмножества в SQL
- [ ] ~300 табличных тестов, property round-trip, fuzzing, SQL vs in-memory
- [ ] CodeMirror-расширение: подсветка, автодополнение по контексту типов, диагностика
- [ ] ADR: свой язык vs JSONata / JSON Logic / isolated-vm

## M4 — Workflow engine (2 недели)
- [ ] `packages/workflow-core`: модель, реестр узлов, валидация графа (достижимость, циклы, доминирование, типы)
- [ ] Таблицы, версии, drafts, publish
- [ ] Триггеры: record_event, record_condition (сканер), schedule, webhook, manual
- [ ] Исполнитель: claim, аренда + heartbeat, семафор тенанта, retries + классификация ошибок, join, error-рёбра, отмена
- [ ] Узлы: condition, switch, create_task, update_record, add_note, notify, send_email, http_request (секреты), wait_duration, wait_until, wait_for_event, approval
- [ ] effect_log / идемпотентность эффектов, защита от циклов (causation)
- [ ] Scheduler с лидер-выбором: аренды, таймеры, потерянные толчки, timeouts, cron
- [ ] Test run (dry-run эффектов)
- [ ] Все 9 обязательных тестов из WORKFLOW_ENGINE.md, включая chaos
- [ ] ADR: Postgres как источник правды, аренды, idempotency key без attempt, свой движок vs Temporal

## M5 — Конструктор и запуски в UI (1.5 недели)
- [ ] React Flow-холст, палитра, панель свойств из схем, поля-выражения с автодополнением, валидация на лету
- [ ] Draft autosave, publish с diff, undo/redo, автолэйаут
- [ ] Test run с живыми статусами на холсте
- [ ] Список запусков, replay на графе, retry / cancel
- [ ] Approvals inbox
- [ ] Галерея из 6 шаблонов

## M6 — MCP, нагрузка, публикация (1 неделя)
- [ ] `ops-mcp`: инструменты с метаданными риска, `dryRun`, `idempotencyKey`, stdio + Streamable HTTP, API-токены со scopes
- [ ] Инструкция «Claude Desktop за 1 минуту» + GIF
- [ ] Нагрузка: 10 000 запусков, 1/2/4 воркера, noisy neighbour, найденное узкое место → исправление → цифры
- [ ] Seed демо-тенанта (компании, сделки, счета, 6 активных workflow), ночной сброс, деплой
- [ ] Публичный README (EN), видео 2–3 минуты

## Сценарий видео
1. Канбан: перетащить сделку в Won (во втором окне она двигается сама).
2. Timeline сделки: workflow «Deal won» создал задачи и черновик счёта.
3. Конструктор: шаблон «Overdue invoice», изменить условие с автодополнением (показать ошибку типа и исправление), Test run, узлы загораются на холсте.
4. Publish → просроченный счёт → письмо в Mailpit → approval в inbox → Approve.
5. Терминал: `kill -9` воркера во время шага `send_email` → replay запуска показывает attempt 2, в Mailpit одно письмо.
6. Claude Desktop через `ops-mcp`: «Покажи просроченные счета больше $1000» → ответ с данными.

## Highlights для README (EN)
- A durable workflow engine built from scratch: leases with heartbeats, retries with backoff, timers that survive restarts, joins and human approvals
- At-least-once step execution with effectively-once side effects (idempotency keys + effect log), proven by kill -9 tests
- A safe, typed expression language (Pratt parser, type checker, SQL compilation) with editor autocomplete based on your custom fields
- Visual builder with live test runs and run replay on the graph
- Kanban, invoices with PDF, custom fields, realtime collaboration, and an MCP server exposing typed tools to AI agents
