# WORKFLOW ENGINE · Durable execution

Главная инженерная часть проекта. Цель — сделать упрощённый аналог Temporal / n8n для бизнес-сценариев **своими руками** и уметь объяснить каждую гарантию.

## 1. Определение workflow

```jsonc
{
  "name": "Overdue invoice follow-up",
  "trigger": {
    "type": "record_condition",                // сканер: запись стала удовлетворять условию
    "entity": "invoice",
    "condition": "invoice.status == 'sent' and invoice.dueDate < now() - days(1)",
    "dedupe": "invoice.id"                     // не запускать повторно для той же записи
  },
  "nodes": [
    { "id": "big", "type": "condition", "config": { "expr": "invoice.totalCents > 100000" } },
    { "id": "notify", "type": "notify", "config": { "to": "invoice.company.owner", "message": "Invoice {{ invoice.number }} is overdue ({{ formatMoney(invoice.totalCents, invoice.currency) }})" } },
    { "id": "task", "type": "create_task", "config": { "title": "Call {{ invoice.company.name }} about {{ invoice.number }}", "assignee": "invoice.company.owner", "dueAt": "now() + days(1)", "relatedTo": "invoice" } },
    { "id": "remind", "type": "send_email", "config": { "template": "invoice_reminder", "to": "invoice.contact.email" },
      "retry": { "maxAttempts": 5, "backoff": "exponential", "initialMs": 30000 } },
    { "id": "wait_paid", "type": "wait_for_event", "config": { "entity": "invoice", "id": "invoice.id", "event": "invoice.paid", "timeout": "days(3)" } },
    { "id": "escalate", "type": "approval", "config": { "assignees": "role('manager')", "title": "Send final notice for {{ invoice.number }}?", "timeout": "days(2)" } },
    { "id": "final", "type": "send_email", "config": { "template": "invoice_final_notice", "to": "invoice.contact.email" } }
  ],
  "edges": [
    { "from": "$trigger", "to": "big" },
    { "from": "big", "to": "notify", "label": "true" },
    { "from": "big", "to": "task",   "label": "true" },
    { "from": "big", "to": "remind", "label": "false" },
    { "from": "notify", "to": "remind" },
    { "from": "task", "to": "remind" },
    { "from": "remind", "to": "wait_paid" },
    { "from": "wait_paid", "to": "escalate", "label": "timeout" },
    { "from": "escalate", "to": "final", "label": "approved" }
  ]
}
```

(`remind` с двумя входящими рёбрами из параллельных веток — это **join**: он ждёт завершения всех входящих веток, которые были активированы.)

### Триггеры

| Тип | Как работает |
|---|---|
| `record_event` | Доменное событие (`deal.stage_changed`, `invoice.created`, `contact.created`…) + опциональный filter-expr |
| `record_condition` | Сканер в `scheduler` раз в минуту выполняет условие как SQL-запрос (выражение компилируется в SQL для поддерживаемого подмножества) → новые совпадения → запуски (дедуп по `dedupe`) |
| `schedule` | Cron + таймзона тенанта |
| `webhook` | `POST /hooks/:workflowId/:secret`, тело валидируется по JSON Schema, заданной в триггере |
| `manual` | Кнопка на записи («Run workflow…») с формой входных параметров |

### Узлы

| Тип | Выходы (рёбра) | Output |
|---|---|---|
| `condition` | `true`, `false` | — |
| `switch` | `case:<name>`, `default` | — |
| `create_task`, `update_record`, `add_note`, `notify` | `next`, `error` | Созданная или изменённая запись |
| `send_email` | `next`, `error` | `{messageId}` |
| `http_request` | `next`, `error` | `{status, body}` (секреты — через `secret('name')`, хранятся зашифрованными) |
| `wait_duration` / `wait_until` | `next` | — |
| `wait_for_event` | `next` (событие пришло), `timeout` | Данные события |
| `approval` | `approved`, `rejected`, `timeout` | `{decidedBy, comment}` |
| `for_each` (v2) | `item` → подграф, `done` | Список результатов; `concurrency` |
| `ai_step` (опционально, связь с проектом 06) | `next`, `error` | Классификация или краткое содержание |
| `end` | — | — |

Реестр узлов (`packages/workflow-core`) описывает для каждого типа: схему `config`, какие поля являются выражениями и их ожидаемые типы, схему `output`, выходы. Из этого строятся валидация, автодополнение в UI и проверка типов.

## 2. Язык выражений (`packages/expr`)

Свой маленький язык: **нельзя использовать `eval`, `new Function`, vm** — ни в каком виде.

```text
expr     := ternary
ternary  := or ('?' expr ':' expr)?
or       := and ('or' and)*
and      := not ('and' not)*
not      := 'not' not | compare
compare  := sum (('=='|'!='|'<'|'<='|'>'|'>='|'in') sum)?
sum      := product (('+'|'-') product)*
product  := unary (('*'|'/'|'%') unary)*
unary    := '-' unary | postfix
postfix  := primary ('.' ident | '?.' ident | '[' expr ']' | '(' args ')')*
primary  := number | string | 'true' | 'false' | 'null' | ident | '(' expr ')' | '[' list ']'
```

- Реализация: lexer → **Pratt-парсер** → AST → **type checker** → evaluator (tree-walking).
- Шаблоны в строках: `"Hello {{ contact.firstName }}"` → разбираются в список частей.
- Функции — только из whitelist: `now()`, `days(n)`, `hours(n)`, `date(s)`, `formatMoney(c, cur)`, `formatDate(d, fmt)`, `lower`, `upper`, `trim`, `contains`, `startsWith`, `len`, `coalesce`, `round`, `min`, `max`, `role(name)`, `user(id)`, `secret(name)` (только в полях `http_request`).
- Типы: `number`, `string`, `bool`, `null`, `date`, `duration`, `money`, `list<T>`, `object{…}`, `user`. `date - date = duration`, `date + duration = date`, `money` сравнивается только с `money` той же валюты или числом минорных единиц.
- **Контекст типов** строится из схемы триггера (сущность + кастомные поля тенанта + связи на 1 уровень: `invoice.company.owner`) и из output-схем предыдущих узлов (`steps.remind.output.messageId`, доступно только если узел гарантированно выполнен раньше по графу — проверка доминирования).
- Ошибки с позицией (`line:col`) → подчёркивание в редакторе конструктора.
- Лимиты: длина выражения ≤ 2000 символов, AST ≤ 500 узлов, строковые результаты ≤ 10 000 символов. Циклов в языке нет → вычисление всегда завершается.
- Доступ только к явному контексту: нет `constructor`, `__proto__`, `prototype` (запрещены как идентификаторы), объекты контекста — plain data (замороженные копии).
- Тесты: таблица из ~300 кейсов (парсинг, типы, вычисление, ошибки) + property-тест (fast-check): случайные AST → печать → парсинг → тот же AST; fuzzing парсера на случайных строках (никогда не падает с необработанным исключением).
- Компиляция подмножества в SQL (для `record_condition`): сравнения, `and`/`or`, `now() ± duration`, поля сущности и кастомные поля. Остальное → ошибка валидации «condition too complex for scanning». Тесты сравнивают SQL-результат с in-memory вычислением на одном наборе записей.

## 3. Хранение

```sql
create table workflows (
  id uuid primary key, tenant_id uuid not null, name text not null,
  status text not null check (status in ('draft','active','paused','archived')),
  active_version int, created_by uuid, created_at timestamptz default now()
);
create table workflow_versions (                   -- неизменяемые
  workflow_id uuid references workflows(id), version int,
  definition jsonb not null, checksum text not null,
  published_by uuid, published_at timestamptz default now(),
  primary key (workflow_id, version)
);
create table workflow_drafts (workflow_id uuid primary key, definition jsonb, updated_by uuid, updated_at timestamptz);

create table workflow_runs (
  id uuid primary key, tenant_id uuid not null, workflow_id uuid not null, version int not null,
  status text not null check (status in ('running','waiting','succeeded','failed','cancelled')),
  trigger_payload jsonb not null,
  context jsonb not null default '{}',             -- outputs шагов
  dedupe_key text,
  causation jsonb not null default '[]',           -- цепочка run_id, породивших событие (защита от циклов)
  is_test boolean not null default false,
  started_at timestamptz default now(), finished_at timestamptz, error jsonb,
  unique (workflow_id, dedupe_key)
);
create table step_runs (
  id uuid primary key, run_id uuid not null references workflow_runs(id), tenant_id uuid not null,
  node_id text not null, iteration int not null default 0,   -- для for_each
  status text not null check (status in ('pending','running','waiting','succeeded','failed','skipped','cancelled')),
  attempt int not null default 0,
  input jsonb, output jsonb, error jsonb,
  idempotency_key text not null,                   -- run_id:node_id:iteration (без attempt!)
  lease_owner text, lease_expires_at timestamptz,
  scheduled_for timestamptz,                       -- для retry backoff и таймеров
  wait jsonb,                                      -- {kind:'event', entity, id, event, expiresAt} | {kind:'approval', approvalId}
  started_at timestamptz, finished_at timestamptz,
  unique (run_id, node_id, iteration)
);
create index on step_runs (status, scheduled_for) where status in ('pending','waiting');
create index on step_runs (lease_expires_at) where status = 'running';

create table approvals (                           -- общие для workflow и AI-агента (проект 06)
  id uuid primary key, tenant_id uuid not null,
  source text check (source in ('workflow','agent')), source_ref jsonb,   -- {runId, stepRunId}
  title text, details jsonb, assignee_ids uuid[], status text, expires_at timestamptz,
  decided_by uuid, decided_at timestamptz, comment text
);
create table effect_log (                          -- идемпотентность побочных эффектов
  idempotency_key text primary key, tenant_id uuid, effect text, result jsonb, created_at timestamptz default now()
);
```

## 4. Исполнение

**Postgres — источник правды. BullMQ-задача — только «толчок»** («посмотри на step_run X»). Если Redis потеряет задачу, sweeper её восстановит; если задача придёт дважды, атомарный claim отсечёт дубль. Это главный ADR проекта.

### Жизненный цикл шага

```text
1. claim (атомарно):
   UPDATE step_runs SET status='running', attempt=attempt+1, lease_owner=$worker,
          lease_expires_at=now()+'30s', started_at=now()
   WHERE id=$id AND status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now())
   RETURNING *;          -- 0 строк → дубль или ещё рано → ack задачи и выход

2. per-tenant семафор (Redis): не больше N одновременно выполняемых шагов на тенант
   (занят → вернуть шаг в pending со scheduled_for = now()+1s)

3. вычислить input: выражения config по context запуска → сохранить input

4. выполнить handler(input, { idempotencyKey, signal, heartbeat }):
   - heartbeat каждые 10 сек продлевает аренду
   - signal (AbortController) срабатывает при timeout узла или отмене запуска
   - handler сначала проверяет effect_log по idempotencyKey → уже сделано → вернуть сохранённый результат

5a. успех → одна транзакция:
   SELECT … FROM workflow_runs WHERE id=$run FOR UPDATE      -- сериализация продвижения запуска
   step → succeeded, output; context[node] = output
   вычислить следующие узлы по рёбрам (label по результату), join: создать шаг, только когда все активированные входящие ветки завершены
   INSERT новые step_runs (pending); если активных шагов нет → run succeeded
   COMMIT → затем enqueue толчков для новых шагов

5b. ошибка:
   retryable и attempt < maxAttempts → status=pending, scheduled_for=now()+backoff(attempt) (+ jitter)
   иначе: есть ребро `error` → идём по нему; нет → run failed, уведомление владельцу workflow
   Классификация: сеть, таймаут, 5xx, 429 → retryable; 4xx, ошибка валидации, ошибка выражения → permanent
```

### Ожидания

| Узел | Как ждёт |
|---|---|
| `wait_duration` / `wait_until` | `status=waiting`, `scheduled_for = момент`; BullMQ delayed job как оптимизация точности; sweeper — страховка |
| `wait_for_event` | `status=waiting`, `wait={event…}`; потребитель доменных событий ищет ожидающие шаги (индекс по `wait->>'entity', wait->>'id'`) → продвигает по `next`; истёк → `timeout` |
| `approval` | Создаётся `approvals`-запись и уведомление; решение (`POST /approvals/:id/decide`) продвигает шаг по `approved` / `rejected`; истёк → `timeout` |

### Scheduler / sweeper (один лидер через Redis-lock с продлением)

Каждые 5 сек:
1. **Истёкшие аренды** (`running` и `lease_expires_at < now()`) → `pending` + толчок. Метрика `workflow_lease_expired_total` показывает, сколько раз умирали воркеры.
2. **Наступившие таймеры** (`waiting`, `scheduled_for <= now()`, `wait` по времени) → завершить и продвинуть.
3. **Потерянные толчки**: `pending` старше 30 сек → повторный толчок.
4. **Истёкшие ожидания событий и approvals** → ветка `timeout`.
5. Cron-триггеры и `record_condition`-сканер (раз в минуту).

### Прочие гарантии и механизмы

- **Идемпотентность эффектов**: `send_email` пишет в `effect_log` в той же транзакции, что и ставит письмо в outbox почты; `create_task` использует `idempotency_key` как уникальный столбец задачи; `http_request` передаёт заголовок `Idempotency-Key`. Итог: **at-least-once исполнение шагов, effectively-once эффекты**.
- **Отмена**: run → `cancelled`, pending/waiting-шаги → `cancelled`, running получают abort через Redis pub/sub `wf:cancel:{runId}`.
- **Retry упавшего шага из UI**: создаётся новая попытка того же шага в той же версии; context сохраняется.
- **Защита от циклов**: события, вызванные действиями запуска, несут `causation`; workflow не запускается событием из собственной цепочки, глубина цепочки ≤ 5.
- **Лимиты**: ≤ 200 шагов на запуск, ≤ 50 000 активных запусков на тенант, rate limit внешних действий (писем в минуту на тенант).
- **Версии**: публикация создаёт неизменяемую версию; запущенные runs закреплены за своей версией; draft редактируется отдельно. Миграция запущенных runs на новую версию — non-goal.
- **Test run**: запуск на выбранной записи или примере payload с `is_test = true`: письма уходят только в Mailpit / превью, HTTP — в режиме dry-run (показать запрос, не отправлять), записи не изменяются (update_record показывает diff).

## 5. Валидация определения при публикации

- Граф: один вход от `$trigger`, нет недостижимых узлов, нет циклов (кроме подграфа `for_each`), у `condition` есть хотя бы одна ветка, все метки рёбер допустимы для типа узла.
- Выражения: парсятся и проходят проверку типов в контексте узла.
- Ссылки на `steps.X.output` только на узлы, которые доминируют над текущим.
- Шаблоны email существуют, получатели имеют тип `string` (email) или `user`.
- Ошибки возвращаются списком с `nodeId` + позицией → UI подсвечивает узлы и поля.

## 6. Наблюдаемость и тесты

**Метрики**: `workflow_runs_total{status}`, `workflow_step_duration_seconds{type}`, `workflow_step_queue_lag_seconds` (от `scheduled_for` до claim), `workflow_timer_lag_seconds` (насколько поздно сработал таймер), `workflow_lease_expired_total`, `workflow_tenant_throttled_total`.
**Трейсинг**: запуск = trace, шаг = span, внешние вызовы вложены.

**Обязательные тесты:**
1. Worker crash: шаг `send_email` с искусственной задержкой → `kill -9` воркера → аренда истекает → другой воркер завершает → **ровно 1 письмо** в Mailpit.
2. Дубль толчка: 10 одинаковых BullMQ-задач на один шаг → handler выполнен 1 раз.
3. Таймер переживает рестарт: `wait_duration 2m` → `docker compose restart` всего → шаг срабатывает с лагом < 10 сек.
4. Потеря Redis: `FLUSHALL` во время выполнения 100 запусков → все завершаются (sweeper).
5. Join: две параллельные ветки завершаются одновременно (гонка) → join-узел создан ровно один раз.
6. Версии: запуск на v1 в ожидании → публикация v2 → запуск завершается по v1.
7. Циклы: workflow «при изменении сделки — обновить сделку» не зацикливается.
8. Noisy neighbour: тенант A создаёт 5000 запусков, тенант B — 10 → латентность шагов B не деградирует больше чем в 2 раза.
9. Язык выражений: таблица кейсов, property, fuzz, SQL vs in-memory.

**Нагрузка (k6 + скрипт)**: массовый триггер 10 000 запусков → шаги/сек, p95 queue lag, поведение при 1, 2, 4 воркерах (масштабирование почти линейное → где упирается: Postgres, блокировка run-строки, семафор). Результаты и найденное узкое место — в README.

## 7. Готовые шаблоны (галерея в UI)

1. Overdue invoice follow-up (пример выше).
2. New lead → round-robin назначение владельца + приветственная задача.
3. Stale deal nudge: сделка без активности 14 дней → уведомление владельцу, через 7 дней — менеджеру.
4. Deal won → задачи онбординга + черновик счёта.
5. Invoice paid → благодарственное письмо + сообщение в Slack (http_request).
6. Weekly pipeline digest по расписанию.

Шаблоны нужны и для онбординга пользователя, и как готовые фикстуры для E2E-тестов.

## 8. ADR этого документа

| Решение | Альтернатива | Почему |
|---|---|---|
| Свой движок | Temporal, n8n, Inngest | Цель проекта — показать понимание durable execution; в README честно: «в продакшене для сложных сценариев я бы рассмотрел Temporal» + сравнение |
| Postgres — источник правды, BullMQ — толчки | Состояние в BullMQ | Транзакционность с доменными данными, восстановление после потери Redis |
| Аренда с heartbeat | Блокировка строки на время выполнения | Долгие шаги не держат транзакцию и соединение |
| Свой язык выражений | JSONata, JSON Logic, JS в sandbox (isolated-vm) | Безопасность, проверка типов, автодополнение, компиляция в SQL |
| Идемпотентный ключ без attempt | Ключ с attempt | Иначе повтор после сбоя повторит эффект |
| Граф (DAG) с join | Линейный список шагов | Реальные сценарии ветвятся, а join — интересная задача |
