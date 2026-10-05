import { ExprError, evaluate, formatValue, hydrate, parseTemplate, T, type EvalEnv } from '@ashamrai/expr';
import type { EmailDraft, EmailMessageDto, EmailTemplateDto, EmailTemplateUpsert, TriggerEntity } from '@bop/contracts';
import { DEFAULT_EMAIL_TEMPLATES, entityType } from '@bop/workflow-core';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId } from '../context';
import { notFound, unprocessable, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { EmailMessage, EmailTemplate } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import type { RecordLoader } from '../engine/records';
import { iso, isoRequired } from '../util/json';
import type { CustomFieldsService } from './custom-fields';
import { escapeHtml } from './invoices';

export interface EnqueueEmail {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  attachInvoice?: string | null;
  idempotencyKey: string | null;
  status?: 'queued' | 'draft';
}

export function renderHtmlTemplate(src: string, env: EvalEnv, escape: boolean): string {
  const parsed = parseTemplate(src);
  const error = parsed.diagnostics.find((d) => d.severity === 'error');
  if (error !== undefined)
    throw unprocessable('template_error', `${error.message} at ${error.start.line}:${error.start.col}`);
  let out = '';
  for (const part of parsed.parts) {
    if (part.kind === 'text') out += part.value;
    else {
      let value: string;
      try {
        value = formatValue(evaluate(part.ast, env));
      } catch (error) {
        if (error instanceof ExprError)
          throw unprocessable('template_error', `Cannot render {{ ${part.source} }}: ${error.message}`);
        throw error;
      }
      out += escape ? escapeHtml(value) : value;
    }
  }
  return out;
}

function templateDto(t: EmailTemplate): EmailTemplateDto {
  return { id: t.id, key: t.key, name: t.name, subject: t.subject, body: t.body, updatedAt: isoRequired(t.updatedAt) };
}

function messageDto(m: EmailMessage): EmailMessageDto {
  return {
    id: m.id,
    status: m.status as EmailMessageDto['status'],
    to: m.toAddresses,
    subject: m.subject,
    html: m.html,
    relatedType: m.relatedType,
    relatedId: m.relatedId,
    actorType: m.actorType,
    sentAt: iso(m.sentAt),
    createdAt: isoRequired(m.createdAt),
  };
}

export class EmailsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly records: RecordLoader,
    private readonly customFields: CustomFieldsService,
  ) {}

  async templates(): Promise<EmailTemplateDto[]> {
    const rows = await this.deps.db.scoped.emailTemplate.findMany({ orderBy: { key: 'asc' } });
    return rows.map(templateDto);
  }

  async templateKeys(): Promise<string[]> {
    const rows = await this.deps.db.scoped.emailTemplate.findMany({ select: { key: true } });
    return rows.map((r) => r.key);
  }

  async upsertTemplate(input: EmailTemplateUpsert): Promise<EmailTemplateDto> {
    for (const [field, src] of [['subject', input.subject] as const, ['body', input.body] as const]) {
      const parsed = parseTemplate(src);
      const err = parsed.diagnostics.find((d) => d.severity === 'error');
      if (err !== undefined)
        throw validationFailed('Template has errors', [
          { path: field, message: `${err.message} at ${err.start.line}:${err.start.col}` },
        ]);
    }
    const row = await this.deps.db.scoped.emailTemplate.upsert({
      where: { tenantId_key: { tenantId: requireTenantId(), key: input.key } },
      create: {
        tenantId: requireTenantId(),
        key: input.key,
        name: input.name,
        subject: input.subject,
        body: input.body,
      },
      update: { name: input.name, subject: input.subject, body: input.body },
    });
    await writeAudit(this.deps.db.scoped, 'email_template.saved', 'email_template', row.id, { key: input.key });
    return templateDto(row);
  }

  async removeTemplate(key: string): Promise<void> {
    await this.deps.db.scoped.emailTemplate.deleteMany({ where: { key } });
  }

  async seedDefaults(tx: Scoped): Promise<void> {
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      await tx.emailTemplate.create({
        data: { tenantId: requireTenantId(), key: t.key, name: t.name, subject: t.subject, body: t.body },
      });
    }
  }

  async templateEnv(
    record: { entity: TriggerEntity; id: string } | null,
    extra: Record<string, unknown> = {},
  ): Promise<EvalEnv> {
    const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: requireTenantId() } });
    const vars: Record<string, unknown> = {
      tenant: hydrate({ id: tenant?.id, name: tenant?.name, slug: tenant?.slug }, T.any),
      ...extra,
    };
    if (record !== null) {
      const json = await this.records.load(record.entity, record.id);
      if (json === null) throw notFound(record.entity);
      vars[record.entity] = hydrate(json, entityType(record.entity, await this.customFields.map()));
    }
    return { vars };
  }

  async renderTemplate(
    key: string,
    record: { entity: TriggerEntity; id: string } | null,
  ): Promise<{ subject: string; html: string }> {
    const template = await this.deps.db.scoped.emailTemplate.findFirst({ where: { key } });
    if (template === null) throw unprocessable('unknown_template', `Email template '${key}' does not exist`);
    const env = await this.templateEnv(record);
    return {
      subject: renderHtmlTemplate(template.subject, env, false),
      html: renderHtmlTemplate(template.body, env, true),
    };
  }

  async preview(input: {
    subject: string;
    body: string;
    entity?: TriggerEntity;
    id?: string;
  }): Promise<{ subject: string; html: string }> {
    const env = await this.templateEnv(
      input.entity !== undefined && input.id !== undefined ? { entity: input.entity, id: input.id } : null,
    );
    return { subject: renderHtmlTemplate(input.subject, env, false), html: renderHtmlTemplate(input.body, env, true) };
  }

  async enqueue(tx: Scoped, msg: EnqueueEmail): Promise<EmailMessage> {
    const ctx = requireContext();
    return tx.emailMessage.create({
      data: {
        tenantId: ctx.tenantId,
        status: msg.status ?? 'queued',
        toAddresses: msg.to,
        ccAddresses: msg.cc ?? [],
        subject: msg.subject,
        html: msg.html,
        text: msg.text ?? null,
        relatedType: msg.relatedType ?? null,
        relatedId: msg.relatedId ?? null,
        attachInvoice: msg.attachInvoice ?? null,
        idempotencyKey: msg.idempotencyKey,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
      },
    });
  }

  async nudge(): Promise<void> {
    await this.deps.queues.emails.add('dispatch', {}, { removeOnComplete: true, removeOnFail: 100 });
  }

  async createDraft(input: EmailDraft): Promise<EmailMessageDto> {
    const row = await this.enqueue(this.deps.db.scoped, {
      to: input.to,
      subject: input.subject,
      html: `<div>${escapeHtml(input.body).replace(/\n/g, '<br>')}</div>`,
      text: input.body,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      idempotencyKey: null,
      status: 'draft',
    });
    return messageDto(row);
  }

  async getMessage(id: string): Promise<EmailMessageDto> {
    const row = await this.deps.db.scoped.emailMessage.findFirst({ where: { id } });
    if (row === null) throw notFound('Email');
    return messageDto(row);
  }

  async sendDraft(id: string): Promise<EmailMessageDto> {
    const row = await this.deps.db.scoped.emailMessage.findFirst({ where: { id } });
    if (row === null) throw notFound('Email draft');
    if (row.status !== 'draft') return messageDto(row);
    const updated = await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.emailMessage.updateMany({ where: { id, status: 'draft' }, data: { status: 'queued' } });
      if (res.count > 0) await writeAudit(tx, 'email.queued', 'email', id, { to: row.toAddresses });
      return (await tx.emailMessage.findFirst({ where: { id } })) as EmailMessage;
    });
    await this.nudge();
    return messageDto(updated);
  }

  async listFor(relatedType: string, relatedId: string): Promise<EmailMessageDto[]> {
    const rows = await this.deps.db.scoped.emailMessage.findMany({
      where: { relatedType, relatedId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(messageDto);
  }

  async markSent(message: EmailMessage, messageId: string): Promise<void> {
    await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.emailMessage.updateMany({
        where: { id: message.id, status: 'sending' },
        data: { status: 'sent', sentAt: new Date(), messageId, leaseUntil: null, error: null },
      });
      if (res.count === 0) return;
      if (message.relatedType !== null && message.relatedId !== null) {
        await emitEvent(tx, {
          type: 'email.sent',
          entity: message.relatedType,
          entityId: message.relatedId,
          payload: {
            emailId: message.id,
            subject: message.subject,
            to: message.toAddresses,
            actorType: message.actorType,
          },
        });
      }
    });
  }
}
