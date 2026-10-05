import { randomUUID } from 'node:crypto';
import {
  invoiceTotals,
  lineTotals,
  invoiceCreateSchema,
  type InvoiceCreate,
  type InvoiceCreateInput,
  type InvoiceDto,
  type InvoiceLineDto,
  type InvoiceSend,
  type InvoiceStatus,
  type InvoiceUpdate,
  type ListQuery,
  type Page,
  type PaymentCreate,
  type PaymentDto,
  type PublicInvoiceDto,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId, runInContext } from '../context';
import { conflict, isUniqueViolation, notFound, preconditionFailed, unprocessable, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Invoice, InvoiceLine, Payment } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import { randomToken } from '../util/crypto';
import { diffObjects, iso, isoRequired, toNumber } from '../util/json';
import { planList, toPage, type FieldMap } from './query';
import type { EmailsService } from './emails';
import { COMPANY_REF_SELECT, CONTACT_REF_SELECT, companyRef, contactRef } from './refs';

export const INVOICE_FIELDS: FieldMap = {
  number: { kind: 'string', sortable: true },
  status: { kind: 'enum', sortable: true },
  companyId: { kind: 'uuid' },
  contactId: { kind: 'uuid', nullable: true },
  dealId: { kind: 'uuid', nullable: true },
  currency: { kind: 'string' },
  issueDate: { kind: 'date', sortable: true },
  dueDate: { kind: 'date', sortable: true },
  totalCents: { kind: 'bigint', sortable: true },
  paidCents: { kind: 'bigint', sortable: true },
  createdByType: { kind: 'string' },
  createdAt: { kind: 'date', sortable: true },
  updatedAt: { kind: 'date', sortable: true },
};

const OPEN_STATUSES: InvoiceStatus[] = ['sent', 'partially_paid', 'overdue'];

function lineDto(l: InvoiceLine): InvoiceLineDto {
  const quantity = Number(String(l.quantity));
  const taxRate = Number(String(l.taxRate));
  const unit = toNumber(l.unitPriceCents);
  const t = lineTotals(quantity, unit, taxRate);
  return {
    id: l.id,
    position: l.position,
    description: l.description,
    quantity,
    unitPriceCents: unit,
    taxRate,
    amountCents: t.amountCents,
    taxCents: t.taxCents,
  };
}

function paymentDto(p: Payment): PaymentDto {
  return {
    id: p.id,
    amountCents: toNumber(p.amountCents),
    method: p.method,
    paidAt: isoRequired(p.paidAt),
    reference: p.reference,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export class InvoicesService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly emails: EmailsService,
  ) {}

  publicUrl(token: string): string {
    return `${this.deps.config.publicWebUrl}/p/invoices/${token}`;
  }

  async toDtos(rows: Invoice[], withDetails = false): Promise<InvoiceDto[]> {
    const companyIds = [...new Set(rows.map((r) => r.companyId))];
    const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => x !== null))];
    const [companies, contacts] = await Promise.all([
      companyIds.length === 0
        ? []
        : this.deps.db.scoped.company.findMany({ where: { id: { in: companyIds } }, select: COMPANY_REF_SELECT }),
      contactIds.length === 0
        ? []
        : this.deps.db.scoped.contact.findMany({
            where: { id: { in: contactIds } },
            select: { ...CONTACT_REF_SELECT, email: true },
          }),
    ]);
    const companyById = new Map(companies.map((c) => [c.id, companyRef(c)]));
    const contactById = new Map(contacts.map((c) => [c.id, { ...contactRef(c), email: c.email }]));
    let lines = new Map<string, InvoiceLineDto[]>();
    let payments = new Map<string, PaymentDto[]>();
    if (withDetails && rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const [l, p] = await Promise.all([
        this.deps.db.scoped.invoiceLine.findMany({ where: { invoiceId: { in: ids } }, orderBy: { position: 'asc' } }),
        this.deps.db.scoped.payment.findMany({ where: { invoiceId: { in: ids } }, orderBy: { paidAt: 'asc' } }),
      ]);
      lines = new Map(ids.map((id) => [id, l.filter((x) => x.invoiceId === id).map(lineDto)]));
      payments = new Map(ids.map((id) => [id, p.filter((x) => x.invoiceId === id).map(paymentDto)]));
    }
    return rows.map((r) => {
      const dto: InvoiceDto = {
        id: r.id,
        number: r.number,
        status: r.status,
        companyId: r.companyId,
        company: companyById.get(r.companyId) ?? null,
        contactId: r.contactId,
        contact: r.contactId === null ? null : (contactById.get(r.contactId) ?? null),
        dealId: r.dealId,
        currency: r.currency,
        issueDate: isoRequired(r.issueDate),
        dueDate: isoRequired(r.dueDate),
        subtotalCents: toNumber(r.subtotalCents),
        taxCents: toNumber(r.taxCents),
        totalCents: toNumber(r.totalCents),
        paidCents: toNumber(r.paidCents),
        balanceCents: toNumber(r.totalCents) - toNumber(r.paidCents),
        notes: r.notes,
        publicToken: r.publicToken,
        publicUrl: this.publicUrl(r.publicToken),
        sentAt: iso(r.sentAt),
        paidAt: iso(r.paidAt),
        createdByType: r.createdByType,
        version: r.version,
        createdAt: isoRequired(r.createdAt),
        updatedAt: isoRequired(r.updatedAt),
      };
      if (withDetails) {
        dto.lines = lines.get(r.id) ?? [];
        dto.payments = payments.get(r.id) ?? [];
      }
      return dto;
    });
  }

  async list(query: ListQuery): Promise<Page<InvoiceDto>> {
    const plan = planList(query, INVOICE_FIELDS, {}, {}, '-issueDate', ['number', 'notes']);
    const rows = await this.deps.db.scoped.invoice.findMany({
      where: plan.where as never,
      orderBy: plan.orderBy as never,
      take: plan.take,
      skip: plan.skip,
    });
    const dtos = await this.toDtos(rows);
    const byId = new Map(dtos.map((d) => [d.id, d]));
    return toPage(rows, plan, query.limit, (r) => byId.get(r.id) as InvoiceDto);
  }

  async getRow(id: string): Promise<Invoice> {
    const row = await this.deps.db.scoped.invoice.findFirst({ where: { id } });
    if (row === null) throw notFound('Invoice');
    return row;
  }

  async get(id: string): Promise<InvoiceDto> {
    return (await this.toDtos([await this.getRow(id)], true))[0] as InvoiceDto;
  }

  private async nextNumber(tx: Scoped, issueDate: Date): Promise<string> {
    const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: requireTenantId() } });
    const prefix = ((tenant?.settings ?? {}) as { invoicePrefix?: string }).invoicePrefix ?? 'INV';
    const year = issueDate.getUTCFullYear();
    const like = `${prefix}-${year}-`;
    const last = await tx.invoice.findFirst({
      where: { number: { startsWith: like } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const seq = last === null ? 1 : Number(last.number.slice(like.length)) + 1;
    return `${like}${String(seq).padStart(4, '0')}`;
  }

  private async assertRefs(input: {
    companyId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
  }): Promise<void> {
    if (
      input.companyId !== undefined &&
      input.companyId !== null &&
      (await this.deps.db.scoped.company.count({ where: { id: input.companyId, deletedAt: null } })) === 0
    ) {
      throw validationFailed('Company not found', [{ path: 'companyId', message: 'unknown company' }]);
    }
    if (
      input.contactId !== undefined &&
      input.contactId !== null &&
      (await this.deps.db.scoped.contact.count({ where: { id: input.contactId } })) === 0
    ) {
      throw validationFailed('Contact not found', [{ path: 'contactId', message: 'unknown contact' }]);
    }
    if (
      input.dealId !== undefined &&
      input.dealId !== null &&
      (await this.deps.db.scoped.deal.count({ where: { id: input.dealId } })) === 0
    ) {
      throw validationFailed('Deal not found', [{ path: 'dealId', message: 'unknown deal' }]);
    }
  }

  async create(raw: InvoiceCreateInput, effectKey: string | null = null): Promise<InvoiceDto> {
    const input = invoiceCreateSchema.parse(raw);
    const tenantId = requireTenantId();
    const ctx = requireContext();
    await this.assertRefs(input);
    const issueDate = input.issueDate !== undefined ? new Date(input.issueDate) : new Date();
    const dueDate = input.dueDate !== undefined ? new Date(input.dueDate) : addDays(issueDate, 14);
    if (dueDate < issueDate)
      throw validationFailed('Due date must not be before the issue date', [
        { path: 'dueDate', message: 'before issue date' },
      ]);
    const totals = invoiceTotals(input.lines);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const row = await this.deps.db.scoped.$transaction(async (tx) => {
          const number = await this.nextNumber(tx, issueDate);
          const created = await tx.invoice.create({
            data: {
              tenantId,
              number,
              companyId: input.companyId,
              contactId: input.contactId ?? null,
              dealId: input.dealId ?? null,
              currency: input.currency,
              issueDate,
              dueDate,
              notes: input.notes ?? null,
              subtotalCents: BigInt(totals.subtotalCents),
              taxCents: BigInt(totals.taxCents),
              totalCents: BigInt(totals.totalCents),
              publicToken: randomToken(24),
              createdByType: ctx.actor.type,
            },
          });
          await this.writeLines(tx, created.id, input.lines);
          if (effectKey !== null) {
            await tx.effectLog.create({
              data: {
                idempotencyKey: effectKey,
                tenantId,
                effect: 'create_invoice',
                result: { invoiceId: created.id },
              },
            });
          }
          await writeAudit(tx, 'invoice.created', 'invoice', created.id, { number, totalCents: totals.totalCents });
          await emitEvent(tx, {
            type: 'invoice.created',
            entity: 'invoice',
            entityId: created.id,
            payload: { number, totalCents: totals.totalCents, companyId: input.companyId },
          });
          return created;
        });
        return this.get(row.id);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
      }
    }
    throw conflict('Could not allocate an invoice number');
  }

  private async writeLines(tx: Scoped, invoiceId: string, lines: InvoiceCreate['lines']): Promise<void> {
    await tx.invoiceLine.deleteMany({ where: { invoiceId } });
    if (lines.length === 0) return;
    await tx.invoiceLine.createMany({
      data: lines.map((l, position) => ({
        tenantId: requireTenantId(),
        invoiceId,
        position,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: BigInt(l.unitPriceCents),
        taxRate: l.taxRate,
      })),
    });
  }

  async update(id: string, input: InvoiceUpdate, expectedVersion?: number): Promise<InvoiceDto> {
    const current = await this.getRow(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw preconditionFailed(await this.get(id));
    if (
      current.status !== 'draft' &&
      (input.lines !== undefined || input.currency !== undefined || input.companyId !== undefined)
    ) {
      throw unprocessable('invoice_locked', 'Only draft invoices can change lines, currency or company');
    }
    if (current.status === 'void' || current.status === 'paid')
      throw unprocessable('invoice_locked', `A ${current.status} invoice cannot be edited`);
    await this.assertRefs(input);
    const totals = input.lines === undefined ? null : invoiceTotals(input.lines);
    await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.invoice.updateMany({
        where: { id, version: current.version },
        data: {
          companyId: input.companyId ?? undefined,
          contactId: input.contactId,
          dealId: input.dealId,
          currency: input.currency,
          issueDate: input.issueDate === undefined ? undefined : new Date(input.issueDate),
          dueDate: input.dueDate === undefined ? undefined : new Date(input.dueDate),
          notes: input.notes,
          subtotalCents: totals === null ? undefined : BigInt(totals.subtotalCents),
          taxCents: totals === null ? undefined : BigInt(totals.taxCents),
          totalCents: totals === null ? undefined : BigInt(totals.totalCents),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw preconditionFailed(null);
      if (input.lines !== undefined) await this.writeLines(tx, id, input.lines);
      const updated = (await tx.invoice.findFirst({ where: { id } })) as Invoice;
      const changes = diffObjects(
        current as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      if (input.lines !== undefined) changes['lines'] = { from: null, to: input.lines.length };
      await writeAudit(tx, 'invoice.updated', 'invoice', id, changes);
      await emitEvent(tx, { type: 'invoice.updated', entity: 'invoice', entityId: id, payload: { changes } });
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const current = await this.getRow(id);
    if (current.status !== 'draft')
      throw unprocessable('invoice_locked', 'Only draft invoices can be deleted; void it instead');
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.delete({ where: { id } });
      await writeAudit(tx, 'invoice.deleted', 'invoice', id, { number: current.number });
    });
  }

  async send(id: string, input: InvoiceSend): Promise<InvoiceDto> {
    const current = await this.getRow(id);
    if (current.status === 'void' || current.status === 'paid')
      throw unprocessable('invalid_status', `A ${current.status} invoice cannot be sent`);
    if (current.totalCents <= 0n)
      throw unprocessable('empty_invoice', 'Add at least one line with an amount before sending');
    let to = input.to ?? [];
    if (to.length === 0 && current.contactId !== null) {
      const contact = await this.deps.db.scoped.contact.findFirst({ where: { id: current.contactId } });
      if (contact?.email) to = [contact.email];
    }
    if (to.length === 0)
      throw validationFailed('No recipient: add a contact with an email or pass "to"', [
        { path: 'to', message: 'required' },
      ]);
    const rendered = await this.emails.renderTemplate('invoice_sent', { entity: 'invoice', id });
    await this.deps.db.scoped.$transaction(async (tx) => {
      const now = new Date();
      await tx.invoice.update({
        where: { id },
        data: {
          status: current.status === 'draft' ? 'sent' : current.status,
          sentAt: current.sentAt ?? now,
          version: { increment: 1 },
        },
      });
      await this.emails.enqueue(tx, {
        to,
        subject: input.subject ?? rendered.subject,
        html: input.message !== undefined ? `<p>${escapeHtml(input.message)}</p>${rendered.html}` : rendered.html,
        relatedType: 'invoice',
        relatedId: id,
        attachInvoice: id,
        idempotencyKey: null,
      });
      await writeAudit(tx, 'invoice.sent', 'invoice', id, { to });
      await emitEvent(tx, {
        type: 'invoice.sent',
        entity: 'invoice',
        entityId: id,
        payload: { number: current.number, to },
      });
    });
    await this.emails.nudge();
    return this.get(id);
  }

  async addPayment(id: string, input: PaymentCreate): Promise<InvoiceDto> {
    const current = await this.getRow(id);
    if (current.status === 'void' || current.status === 'draft')
      throw unprocessable('invalid_status', `Payments cannot be recorded on a ${current.status} invoice`);
    const balance = toNumber(current.totalCents) - toNumber(current.paidCents);
    if (input.amountCents > balance)
      throw validationFailed('Payment exceeds the outstanding balance', [
        { path: 'amountCents', message: `max ${balance}` },
      ]);
    await this.deps.db.scoped.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId: requireTenantId(),
          invoiceId: id,
          amountCents: BigInt(input.amountCents),
          method: input.method,
          paidAt: input.paidAt !== undefined ? new Date(input.paidAt) : new Date(),
          reference: input.reference ?? null,
        },
      });
      const paid = toNumber(current.paidCents) + input.amountCents;
      const fullyPaid = paid >= toNumber(current.totalCents);
      const status: InvoiceStatus = fullyPaid ? 'paid' : 'partially_paid';
      const res = await tx.invoice.updateMany({
        where: { id, version: current.version },
        data: { paidCents: BigInt(paid), status, paidAt: fullyPaid ? new Date() : null, version: { increment: 1 } },
      });
      if (res.count === 0) throw conflict('Invoice changed concurrently, retry the payment');
      await writeAudit(tx, 'payment.created', 'invoice', id, { amountCents: input.amountCents, method: input.method });
      const payload = {
        number: current.number,
        amountCents: input.amountCents,
        paidCents: paid,
        totalCents: toNumber(current.totalCents),
        paymentId: payment.id,
      };
      await emitEvent(tx, { type: 'payment.created', entity: 'invoice', entityId: id, payload });
      await emitEvent(tx, {
        type: fullyPaid ? 'invoice.paid' : 'invoice.partially_paid',
        entity: 'invoice',
        entityId: id,
        payload,
      });
    });
    return this.get(id);
  }

  async void(id: string, reason?: string): Promise<InvoiceDto> {
    const current = await this.getRow(id);
    if (current.status === 'void') return this.get(id);
    if (current.status === 'paid') throw unprocessable('invalid_status', 'A paid invoice cannot be voided');
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: { status: 'void', voidedAt: new Date(), version: { increment: 1 } },
      });
      await writeAudit(tx, 'invoice.voided', 'invoice', id, { reason: reason ?? null });
      await emitEvent(tx, {
        type: 'invoice.voided',
        entity: 'invoice',
        entityId: id,
        payload: { number: current.number, reason: reason ?? null },
      });
    });
    return this.get(id);
  }

  async previewVoid(id: string): Promise<{ invoice: InvoiceDto; change: Record<string, unknown> }> {
    const invoice = await this.get(id);
    return { invoice, change: { status: { from: invoice.status, to: 'void' }, allowed: invoice.status !== 'paid' } };
  }

  async findByToken(token: string): Promise<{ tenantId: string; invoice: Invoice } | null> {
    const row = await this.deps.db.system.invoice.findUnique({ where: { publicToken: token } });
    return row === null ? null : { tenantId: row.tenantId, invoice: row };
  }

  async publicView(token: string): Promise<PublicInvoiceDto | null> {
    const found = await this.findByToken(token);
    if (found === null || found.invoice.status === 'draft') return null;
    return runInContext({ tenantId: found.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
      const dto = await this.get(found.invoice.id);
      const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: found.tenantId } });
      return {
        number: dto.number,
        status: dto.status,
        currency: dto.currency,
        issueDate: dto.issueDate,
        dueDate: dto.dueDate,
        subtotalCents: dto.subtotalCents,
        taxCents: dto.taxCents,
        totalCents: dto.totalCents,
        paidCents: dto.paidCents,
        balanceCents: dto.balanceCents,
        seller: tenant?.name ?? '',
        buyer: dto.company?.name ?? '',
        lines: dto.lines ?? [],
        notes: dto.notes,
      };
    });
  }

  async publicPay(token: string): Promise<PublicInvoiceDto | null> {
    const found = await this.findByToken(token);
    if (found === null) return null;
    const balance = toNumber(found.invoice.totalCents) - toNumber(found.invoice.paidCents);
    if (balance > 0 && OPEN_STATUSES.includes(found.invoice.status)) {
      await runInContext({ tenantId: found.tenantId, actor: { type: 'system', id: null }, causation: [] }, () =>
        this.addPayment(found.invoice.id, {
          amountCents: balance,
          method: 'card_demo',
          reference: `demo-${randomUUID().slice(0, 8)}`,
        }),
      );
    }
    return this.publicView(token);
  }

  async markOverdue(now: Date): Promise<number> {
    const due = await this.deps.db.system.invoice.findMany({
      where: { status: { in: ['sent', 'partially_paid'] }, dueDate: { lt: new Date(now.getTime() - 86_400_000) } },
      select: { id: true, tenantId: true, number: true, version: true },
      take: 500,
    });
    let count = 0;
    for (const inv of due) {
      await runInContext({ tenantId: inv.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
        await this.deps.db.scoped.$transaction(async (tx) => {
          const res = await tx.invoice.updateMany({
            where: { id: inv.id, version: inv.version },
            data: { status: 'overdue', version: { increment: 1 } },
          });
          if (res.count === 0) return;
          count += 1;
          await writeAudit(tx, 'invoice.overdue', 'invoice', inv.id, {});
          await emitEvent(tx, {
            type: 'invoice.overdue',
            entity: 'invoice',
            entityId: inv.id,
            payload: { number: inv.number },
          });
        });
      });
    }
    return count;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
