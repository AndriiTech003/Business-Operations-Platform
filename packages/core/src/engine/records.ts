import type { TriggerEntity, UserSummary } from '@bop/contracts';
import type { CoreDeps } from '../deps';
import type { Company, Contact, Deal, Invoice, Task } from '../generated/prisma/client';
import { iso, isoRequired, toNumber } from '../util/json';
import type { Directory } from '../services/directory';

export type RecordJson = Record<string, unknown>;

export class RecordLoader {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
  ) {}

  private user(users: Map<string, UserSummary>, id: string | null): UserSummary | null {
    return id === null ? null : (users.get(id) ?? null);
  }

  companyJson(c: Company, users: Map<string, UserSummary>): RecordJson {
    return {
      id: c.id,
      name: c.name,
      domain: c.domain,
      industry: c.industry,
      size: c.size,
      ownerId: c.ownerId,
      owner: this.user(users, c.ownerId),
      tags: c.tags,
      custom: c.custom ?? {},
      createdAt: isoRequired(c.createdAt),
      updatedAt: isoRequired(c.updatedAt),
    };
  }

  contactJson(c: Contact, users: Map<string, UserSummary>): RecordJson {
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      phone: c.phone,
      title: c.title,
      status: c.status,
      source: c.source,
      companyId: c.companyId,
      ownerId: c.ownerId,
      owner: this.user(users, c.ownerId),
      lastContactedAt: iso(c.lastContactedAt),
      tags: c.tags,
      custom: c.custom ?? {},
      createdAt: isoRequired(c.createdAt),
      updatedAt: isoRequired(c.updatedAt),
    };
  }

  async dealJson(d: Deal, users: Map<string, UserSummary>): Promise<RecordJson> {
    const stage = await this.deps.db.scoped.stage.findFirst({ where: { id: d.stageId } });
    return {
      id: d.id,
      title: d.title,
      amountCents: toNumber(d.amountCents),
      currency: d.currency,
      pipelineId: d.pipelineId,
      stageId: d.stageId,
      stage:
        stage === null ? null : { id: stage.id, name: stage.name, kind: stage.kind, probability: stage.probability },
      companyId: d.companyId,
      contactId: d.contactId,
      ownerId: d.ownerId,
      owner: this.user(users, d.ownerId),
      expectedCloseAt: iso(d.expectedCloseAt),
      stageChangedAt: isoRequired(d.stageChangedAt),
      lastActivityAt: isoRequired(d.lastActivityAt),
      closedAt: iso(d.closedAt),
      lostReason: d.lostReason,
      tags: d.tags,
      custom: d.custom ?? {},
      createdAt: isoRequired(d.createdAt),
      updatedAt: isoRequired(d.updatedAt),
    };
  }

  invoiceJson(i: Invoice): RecordJson {
    return {
      id: i.id,
      number: i.number,
      status: i.status,
      currency: i.currency,
      issueDate: isoRequired(i.issueDate),
      dueDate: isoRequired(i.dueDate),
      subtotalCents: toNumber(i.subtotalCents),
      taxCents: toNumber(i.taxCents),
      totalCents: toNumber(i.totalCents),
      paidCents: toNumber(i.paidCents),
      balanceCents: toNumber(i.totalCents) - toNumber(i.paidCents),
      companyId: i.companyId,
      contactId: i.contactId,
      dealId: i.dealId,
      publicUrl: `${this.deps.config.publicWebUrl}/p/invoices/${i.publicToken}`,
      sentAt: iso(i.sentAt),
      paidAt: iso(i.paidAt),
      createdAt: isoRequired(i.createdAt),
      updatedAt: isoRequired(i.updatedAt),
    };
  }

  taskJson(t: Task, users: Map<string, UserSummary>): RecordJson {
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueAt: iso(t.dueAt),
      assigneeId: t.assigneeId,
      assignee: this.user(users, t.assigneeId),
      relatedType: t.relatedType,
      relatedId: t.relatedId,
      createdByType: t.createdByType,
      completedAt: iso(t.completedAt),
      createdAt: isoRequired(t.createdAt),
    };
  }

  async load(entity: TriggerEntity, id: string, withRelations = true): Promise<RecordJson | null> {
    const db = this.deps.db.scoped;
    switch (entity) {
      case 'company': {
        const c = await db.company.findFirst({ where: { id } });
        if (c === null) return null;
        const users = await this.directory.usersById([c.ownerId]);
        const json = this.companyJson(c, users);
        if (withRelations)
          json['contactsCount'] = await db.contact.count({ where: { companyId: id, deletedAt: null } });
        return json;
      }
      case 'contact': {
        const c = await db.contact.findFirst({ where: { id } });
        if (c === null) return null;
        const company =
          withRelations && c.companyId !== null ? await db.company.findFirst({ where: { id: c.companyId } }) : null;
        const users = await this.directory.usersById([c.ownerId, company?.ownerId]);
        const json = this.contactJson(c, users);
        if (withRelations) json['company'] = company === null ? null : this.companyJson(company, users);
        return json;
      }
      case 'deal': {
        const d = await db.deal.findFirst({ where: { id } });
        if (d === null) return null;
        const [company, contact] = withRelations
          ? await Promise.all([
              d.companyId === null ? null : db.company.findFirst({ where: { id: d.companyId } }),
              d.contactId === null ? null : db.contact.findFirst({ where: { id: d.contactId } }),
            ])
          : [null, null];
        const users = await this.directory.usersById([d.ownerId, company?.ownerId, contact?.ownerId]);
        const json = await this.dealJson(d, users);
        if (withRelations) {
          json['company'] = company === null ? null : this.companyJson(company, users);
          json['contact'] = contact === null ? null : this.contactJson(contact, users);
        }
        return json;
      }
      case 'invoice': {
        const i = await db.invoice.findFirst({ where: { id } });
        if (i === null) return null;
        const json = this.invoiceJson(i);
        if (withRelations) {
          const [company, contact, deal] = await Promise.all([
            db.company.findFirst({ where: { id: i.companyId } }),
            i.contactId === null ? null : db.contact.findFirst({ where: { id: i.contactId } }),
            i.dealId === null ? null : db.deal.findFirst({ where: { id: i.dealId } }),
          ]);
          const users = await this.directory.usersById([company?.ownerId, contact?.ownerId, deal?.ownerId]);
          json['company'] = company === null ? null : this.companyJson(company, users);
          json['contact'] = contact === null ? null : this.contactJson(contact, users);
          json['deal'] = deal === null ? null : await this.dealJson(deal, users);
        }
        return json;
      }
      case 'task': {
        const t = await db.task.findFirst({ where: { id } });
        if (t === null) return null;
        return this.taskJson(t, await this.directory.usersById([t.assigneeId]));
      }
    }
  }
}
