# SPEC · Business Operations Platform

## 1. Стек

| Слой | Технология | Почему (и чем отличается от других проектов) |
|---|---|---|
| API | NestJS 11 | Большой домен, модули, DI |
| ORM | **Prisma** + client extension для tenant scoping | Во флагмане Drizzle + RLS, здесь показан другой подход, сравнение в ADR |
| БД | PostgreSQL 17 | JSONB для кастомных полей и определений workflow, FTS для поиска |
| Очереди | **BullMQ** (Redis) | Отложенные задачи, приоритеты, rate limit; хорошо подходит для исполнения шагов |
| Realtime | `@scope/realtime-client` + сервер из проекта 03 (или встроенный `ws`-gateway, если 03 ещё не готов) | Живые обновления канбана, уведомления, presence на записи |
| PDF | Playwright/Chromium (HTML-шаблон → PDF) в отдельном воркере | Верстать счета удобно в HTML |
| Email | Nodemailer → Mailpit (dev), SMTP / Resend (demo) | |
| Frontend | React 19 + Vite + TanStack Router / Query / Table, React Flow, dnd-kit, shadcn/ui | SPA-приложение для работы, SEO не нужен |
| MCP | `@modelcontextprotocol/sdk` (TypeScript) | Инструменты для AI-агента |
| Качество | Vitest, Testcontainers, Playwright, k6 | |

## 2. Архитектура

```text
apps/
├── api/                 # NestJS: домен + REST + webhooks-in + MCP (отдельный entrypoint)
├── worker/              # BullMQ-воркеры: workflow steps, emails, pdf, imports, scheduled scans
├── scheduler/           # Лидер-выбор (Redis lock): cron-триггеры, сканер просрочек, sweeper таймеров и аренд
├── web/                 # React SPA
└── ops-mcp/             # MCP-сервер (stdio + Streamable HTTP), ходит в API с токеном пользователя
packages/
├── contracts/           # zod-схемы, типы событий, DTO
├── expr/                # язык выражений: lexer, Pratt-парсер, type checker, evaluator (0 зависимостей)
├── workflow-core/       # модель определений, валидация графа, реестр узлов (типы входов/выходов)
└── ui/
```

Доменные события (`invoice.created`, `deal.stage_changed`…) пишутся в outbox в той же транзакции (паттерн уже показан в проекте 01, здесь переиспользуется идея, но relay кладёт события в BullMQ-очередь `events`). Потребители событий: workflow-триггеры, уведомления, активность, поиск.

## 3. Доменная модель и схема (Prisma, упрощённо)

```prisma
model Tenant        { id String @id; slug String @unique; name String; settings Json; createdAt DateTime @default(now()) }
model User          { id String @id; email String @unique; name String; passwordHash String }
model Membership    { tenantId String; userId String; role Role; @@id([tenantId, userId]) }   // owner|admin|manager|member|viewer

model Company {
  id String @id; tenantId String; name String; domain String?; industry String?; size Int?
  ownerId String?; custom Json @default("{}"); tags String[]
  createdAt DateTime @default(now()); updatedAt DateTime @updatedAt; deletedAt DateTime?
  @@index([tenantId, name])
}
model Contact {
  id String @id; tenantId String; companyId String?; firstName String; lastName String
  email String?; phone String?; title String?; ownerId String?; custom Json @default("{}")
  lastContactedAt DateTime?; status ContactStatus   // lead|active|customer|churned
  @@unique([tenantId, email])
}
model Pipeline      { id String @id; tenantId String; name String; stages Stage[] }
model Stage         { id String @id; pipelineId String; name String; position Int; probability Int; kind StageKind } // open|won|lost
model Deal {
  id String @id; tenantId String; pipelineId String; stageId String; companyId String?; contactId String?
  title String; amountCents BigInt; currency String; expectedCloseAt DateTime?; ownerId String?
  position Float   // дробный индекс для порядка в колонке канбана (без пересчёта всех позиций)
  custom Json @default("{}"); stageChangedAt DateTime; closedAt DateTime?; lostReason String?
}
model Invoice {
  id String @id; tenantId String; number String; companyId String; contactId String?
  status InvoiceStatus; currency String; issueDate DateTime; dueDate DateTime
  subtotalCents BigInt; taxCents BigInt; totalCents BigInt; paidCents BigInt @default(0)
  publicToken String @unique; pdfKey String?; sentAt DateTime?; version Int @default(1)
  @@unique([tenantId, number])
}
model InvoiceLine   { id String @id; invoiceId String; description String; quantity Decimal; unitPriceCents BigInt; taxRate Decimal }
model Payment       { id String @id; invoiceId String; amountCents BigInt; method String; paidAt DateTime; reference String? }
model Task {
  id String @id; tenantId String; title String; description String?; assigneeId String?; dueAt DateTime?
  status TaskStatus; priority Int; relatedType String?; relatedId String?; createdByType String // user|workflow|agent
  createdById String?; completedAt DateTime?
}
model Activity      { id String @id; tenantId String; subjectType String; subjectId String; kind String; actorType String; actorId String?; data Json; createdAt DateTime @default(now()) }
model Comment       { id String @id; tenantId String; subjectType String; subjectId String; authorId String; body String; mentions String[] }
model Notification  { id String @id; tenantId String; userId String; kind String; payload Json; readAt DateTime?; createdAt DateTime @default(now()) }
model CustomFieldDef{ id String @id; tenantId String; entity String; key String; label String; type String; options Json?; required Boolean; position Int; @@unique([tenantId, entity, key]) }
model AuditLog      { id String @id; tenantId String; actorType String; actorId String?; action String; entity String; entityId String; diff Json; createdAt DateTime @default(now()) }
model ApiToken      { id String @id; tenantId String; userId String; name String; tokenHash String @unique; scopes String[]; expiresAt DateTime?; lastUsedAt DateTime? }
model Outbox        { id String @id; tenantId String; type String; payload Json; createdAt DateTime @default(now()); publishedAt DateTime? }
// Workflow-модели — в WORKFLOW_ENGINE.md
```

`actorType` = `user | workflow | agent | system` во всех журналах. Так в аудите видно, что сделал человек, что сделал workflow, а что — AI-агент (проект 06).

### Tenant scoping через Prisma extension

```ts
export const tenantPrisma = (base: PrismaClient, ctx: TenantContext) => base.$extends({
  query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    if (!TENANT_MODELS.has(model)) return query(args);
    const tenantId = ctx.require();                                   // бросает, если контекста нет
    if (READ_OPS.has(operation)) args.where = { ...args.where, tenantId };
    if (CREATE_OPS.has(operation)) args.data = withTenant(args.data, tenantId);
    if (WRITE_OPS.has(operation)) args.where = { ...args.where, tenantId };
    return query(args);
  } } },
});
```

- Тест проходит по **всем** моделям и операциям Prisma и проверяет, что без контекста — ошибка, а с контекстом A данные B не видны.
- ADR-сравнение с RLS (проект 01): extension проще и переносимее, но это защита на уровне приложения. Raw SQL (`$queryRaw`) её обходит, поэтому raw SQL запрещён линтером, кроме репозитория отчётов, где tenant-фильтр проверяется тестом.

### Кастомные поля
- Хранятся в `custom` JSONB, определения — в `CustomFieldDef`.
- Валидация: из определений динамически строится zod-схема (кэш по версии определений тенанта).
- Фильтрация и сортировка по кастомным полям: expression-индексы создаются по запросу (`CREATE INDEX CONCURRENTLY … ((custom->>'region'))`) для полей с флагом `indexed` (лимит 5 на сущность).
- Кастомные поля доступны в workflow-выражениях и в автодополнении конструктора (`deal.custom.region`).

### Поиск
- Postgres FTS: `tsvector` по основным полям каждой сущности + таблица `search_documents(tenant_id, entity, entity_id, tsv, title, subtitle)`, обновляется из outbox-событий.
- ⌘K: один запрос по `search_documents`, группировка по типу, trigram для опечаток.

## 4. API (основное)

REST `/v1`, problem+json, cursor-пагинация, `If-Match` для оптимистичных блокировок (сделки, счета), `Idempotency-Key` на создании счёта, платежа и отправке писем.

| Группа | Endpoints |
|---|---|
| Companies / Contacts | CRUD, `/:id/timeline`, `/import` (CSV → job), `/merge` (дубликаты) |
| Deals | CRUD, `PATCH /deals/:id/move {stageId, beforeId, afterId}` (дробный индекс), `/forecast` |
| Invoices | CRUD, `/:id/send` (email + PDF), `/:id/payments`, `/:id/void`, `/:id/pdf`, публичная `/p/invoices/:token` |
| Tasks | CRUD, `/my`, bulk complete |
| Custom fields | CRUD определений на сущность |
| Workflows | см. WORKFLOW_ENGINE.md |
| Approvals | `GET /approvals?status=pending`, `POST /approvals/:id/decide {approve|reject, comment}` (общие для workflow и AI-агента); `POST /approvals` — создание внешним источником (AI-агент, service token со scope `approvals:create`), решение уходит вебхуком на `callbackUrl` |
| Notifications | список, mark read, SSE/WS-подписка |
| Search | `GET /search?q=` |
| Reports | `/reports/pipeline`, `/reports/revenue`, `/reports/ar-aging`, `/reports/activity` |
| Webhooks in | `POST /hooks/:workflowId/:secret` — webhook-триггер workflow |
| API tokens | персональные токены со scopes (используются MCP-сервером и агентом) |

## 5. MCP-сервер `ops-mcp`

Тонкий слой над API, который **ходит от имени пользователя** (его токен и его права). Каждый инструмент описан zod-схемой и метаданными риска:

| Инструмент | Риск | Описание |
|---|---|---|
| `search_records(query, types?)` | read | Глобальный поиск |
| `get_company / get_contact / get_deal / get_invoice(id)` | read | Детали с последними активностями |
| `list_contacts(filter)` | read | Фильтр: status, owner, `lastContactedBefore`, tags, custom fields |
| `list_deals(filter)` | read | stage, owner, amount range, `stageChangedBefore` |
| `list_invoices(filter)` | read | status, `dueBefore`, `overdueDays`, amount range |
| `get_report(name, params)` | read | Готовые отчёты (никакого произвольного SQL) |
| `create_task(input)` | write_reversible | |
| `add_note(subject, body)` | write_reversible | |
| `update_deal(id, patch)` | write_reversible | Стадия, сумма, владелец, кастомные поля |
| `draft_email(to, subject, body, relatedTo)` | write_reversible | Создаёт черновик, не отправляет |
| `send_email(draftId)` | external | Отправка наружу |
| `send_invoice(id)` | external | |
| `void_invoice(id)` | irreversible | |

- Метаданные риска (`annotations`: `readOnlyHint`, `destructiveHint`, `idempotentHint` + своё поле `x-risk`) использует агент (проект 06) в своей политике.
- Все write-инструменты принимают `idempotencyKey` и поддерживают `dryRun: true` (возвращает превью изменения без применения).
- Результаты read-инструментов помечают поля, заполненные внешними людьми (тело входящего письма, заметки из веб-формы, поля, пришедшие через webhook), списком `untrusted: [...]`. Агент из проекта 06 использует это для защиты от prompt injection.
- Транспорт: stdio (Claude Desktop, IDE) и Streamable HTTP (агент из проекта 06).
- Отдельный README-раздел: «Подключить к Claude Desktop за 1 минуту» + GIF.
