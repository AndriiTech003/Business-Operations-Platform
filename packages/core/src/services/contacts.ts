import {
  contactCreateSchema,
  type ContactCreateInput,
  type ContactDto,
  type ContactUpdate,
  type ListQuery,
  type MergeInput,
  type Page,
  type RecordRef,
  type UserSummary,
  EXTERNAL_SOURCES as EXTERNAL_SOURCE_LIST,
  contactUntrustedFields,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { COMPANY_REF_SELECT, companyRef } from './refs';
import { requireTenantId } from '../context';
import { conflict, isUniqueViolation, notFound, preconditionFailed, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Contact } from '../generated/prisma/client';
import { diffObjects, iso, isoRequired } from '../util/json';
import type { CustomFieldsService } from './custom-fields';
import type { Directory } from './directory';
import { planList, toPage, type FieldMap } from './query';
import { orderedIdsByCustom } from './custom-sort';

export const CONTACT_FIELDS: FieldMap = {
  firstName: { kind: 'string', sortable: true },
  lastName: { kind: 'string', sortable: true },
  email: { kind: 'string', nullable: true, sortable: true },
  phone: { kind: 'string', nullable: true },
  title: { kind: 'string', nullable: true },
  status: { kind: 'enum', sortable: true },
  source: { kind: 'string', nullable: true },
  companyId: { kind: 'uuid', nullable: true },
  ownerId: { kind: 'uuid', nullable: true },
  tags: { kind: 'tags' },
  lastContactedAt: { kind: 'date', nullable: true, sortable: true },
  createdAt: { kind: 'date', sortable: true },
  updatedAt: { kind: 'date', sortable: true },
};

export const EXTERNAL_SOURCES = new Set(EXTERNAL_SOURCE_LIST);

export function contactDto(c: Contact, users: Map<string, UserSummary>, companies: Map<string, RecordRef>): ContactDto {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    name: `${c.firstName} ${c.lastName}`.trim(),
    email: c.email,
    phone: c.phone,
    title: c.title,
    companyId: c.companyId,
    company: c.companyId === null ? null : (companies.get(c.companyId) ?? { id: c.companyId, name: 'Unknown' }),
    ownerId: c.ownerId,
    owner: c.ownerId === null ? null : (users.get(c.ownerId) ?? null),
    status: c.status,
    source: c.source,
    lastContactedAt: iso(c.lastContactedAt),
    custom: (c.custom ?? {}) as Record<string, unknown>,
    tags: c.tags,
    version: c.version,
    createdAt: isoRequired(c.createdAt),
    updatedAt: isoRequired(c.updatedAt),
    untrusted: contactUntrustedFields(c),
  };
}

export class ContactsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
    private readonly customFields: CustomFieldsService,
  ) {}

  private async companyNames(ids: Array<string | null>): Promise<Map<string, RecordRef>> {
    const unique = [...new Set(ids.filter((x): x is string => x !== null))];
    if (unique.length === 0) return new Map();
    const rows = await this.deps.db.scoped.company.findMany({
      where: { id: { in: unique } },
      select: COMPANY_REF_SELECT,
    });
    return new Map(rows.map((r) => [r.id, companyRef(r)]));
  }

  async toDtos(rows: Contact[]): Promise<ContactDto[]> {
    const [users, companies] = await Promise.all([
      this.directory.usersById(rows.map((r) => r.ownerId)),
      this.companyNames(rows.map((r) => r.companyId)),
    ]);
    return rows.map((r) => contactDto(r, users, companies));
  }

  async list(query: ListQuery): Promise<Page<ContactDto>> {
    const customTypes = await this.customFields.typesFor('contact');
    const plan = planList(query, CONTACT_FIELDS, customTypes, { deletedAt: null }, 'lastName', [
      'firstName',
      'lastName',
      'email',
      'title',
    ]);
    let rows: Contact[];
    if (plan.customSort !== null) {
      const ids = await orderedIdsByCustom(this.deps, 'contact', plan, query.limit);
      const found = await this.deps.db.scoped.contact.findMany({ where: { id: { in: ids } } });
      const byId = new Map(found.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter((r): r is Contact => r !== undefined);
    } else {
      rows = await this.deps.db.scoped.contact.findMany({
        where: plan.where as never,
        orderBy: plan.orderBy as never,
        take: plan.take,
        skip: plan.skip,
      });
    }
    const dtos = await this.toDtos(rows);
    const byId = new Map(dtos.map((d) => [d.id, d]));
    return toPage(rows, plan, query.limit, (r) => byId.get(r.id) as ContactDto);
  }

  async getRow(id: string): Promise<Contact> {
    const row = await this.deps.db.scoped.contact.findFirst({ where: { id, deletedAt: null } });
    if (row === null) throw notFound('Contact');
    return row;
  }

  async get(id: string): Promise<ContactDto> {
    return (await this.toDtos([await this.getRow(id)]))[0] as ContactDto;
  }

  private async assertRefs(input: { ownerId?: string | null; companyId?: string | null }): Promise<void> {
    if (input.ownerId !== null && input.ownerId !== undefined && !(await this.directory.isMember(input.ownerId))) {
      throw validationFailed('Owner must be a member of the workspace', [{ path: 'ownerId', message: 'unknown user' }]);
    }
    if (input.companyId !== null && input.companyId !== undefined) {
      const company = await this.deps.db.scoped.company.findFirst({
        where: { id: input.companyId, deletedAt: null },
        select: { id: true },
      });
      if (company === null)
        throw validationFailed('Company not found', [{ path: 'companyId', message: 'unknown company' }]);
    }
  }

  async create(raw: ContactCreateInput): Promise<ContactDto> {
    const input = contactCreateSchema.parse(raw);
    const tenantId = requireTenantId();
    await this.assertRefs(input);
    const custom = await this.customFields.validate('contact', input.custom, false);
    try {
      const row = await this.deps.db.scoped.$transaction(async (tx) => {
        const created = await tx.contact.create({
          data: {
            tenantId,
            firstName: input.firstName,
            lastName: input.lastName ?? '',
            email: input.email?.toLowerCase() ?? null,
            phone: input.phone ?? null,
            title: input.title ?? null,
            companyId: input.companyId ?? null,
            ownerId: input.ownerId ?? null,
            status: input.status ?? 'lead',
            source: input.source ?? null,
            custom: custom as never,
            tags: input.tags ?? [],
          },
        });
        await writeAudit(tx, 'contact.created', 'contact', created.id, { after: created });
        await emitEvent(tx, {
          type: 'contact.created',
          entity: 'contact',
          entityId: created.id,
          payload: { name: `${created.firstName} ${created.lastName}`.trim(), companyId: created.companyId },
        });
        return created;
      });
      return this.get(row.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A contact with email ${input.email ?? ''} already exists`);
      throw error;
    }
  }

  async update(id: string, input: ContactUpdate, expectedVersion?: number): Promise<ContactDto> {
    const current = await this.getRow(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw preconditionFailed(await this.get(id));
    await this.assertRefs(input);
    const custom =
      input.custom === undefined
        ? undefined
        : {
            ...((current.custom ?? {}) as Record<string, unknown>),
            ...(await this.customFields.validate('contact', input.custom, true)),
          };
    try {
      await this.deps.db.scoped.$transaction(async (tx) => {
        const res = await tx.contact.updateMany({
          where: { id, version: current.version },
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email === undefined ? undefined : (input.email?.toLowerCase() ?? null),
            phone: input.phone,
            title: input.title,
            companyId: input.companyId,
            ownerId: input.ownerId,
            status: input.status,
            source: input.source,
            custom: custom as never,
            tags: input.tags,
            version: { increment: 1 },
          },
        });
        if (res.count === 0) throw preconditionFailed(null);
        const updated = (await tx.contact.findFirst({ where: { id } })) as Contact;
        const changes = diffObjects(
          current as unknown as Record<string, unknown>,
          updated as unknown as Record<string, unknown>,
        );
        await writeAudit(tx, 'contact.updated', 'contact', id, changes);
        if (Object.keys(changes).length > 0)
          await emitEvent(tx, { type: 'contact.updated', entity: 'contact', entityId: id, payload: { changes } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A contact with email ${input.email ?? ''} already exists`);
      throw error;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.contact.update({
        where: { id },
        data: { deletedAt: new Date(), email: null, version: { increment: 1 } },
      });
      await writeAudit(tx, 'contact.deleted', 'contact', id, {});
      await emitEvent(tx, { type: 'contact.deleted', entity: 'contact', entityId: id });
    });
  }

  async merge(input: MergeInput): Promise<ContactDto> {
    const target = await this.getRow(input.targetId);
    const sources = await this.deps.db.scoped.contact.findMany({
      where: { id: { in: input.sourceIds }, deletedAt: null },
    });
    if (sources.length !== input.sourceIds.length || input.sourceIds.includes(target.id)) {
      throw validationFailed('Invalid merge request', [{ path: 'sourceIds', message: 'unknown or same as target' }]);
    }
    const ids = sources.map((s) => s.id);
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.deal.updateMany({ where: { contactId: { in: ids } }, data: { contactId: target.id } });
      await tx.invoice.updateMany({ where: { contactId: { in: ids } }, data: { contactId: target.id } });
      await tx.task.updateMany({
        where: { relatedType: 'contact', relatedId: { in: ids } },
        data: { relatedId: target.id },
      });
      await tx.activity.updateMany({
        where: { subjectType: 'contact', subjectId: { in: ids } },
        data: { subjectId: target.id },
      });
      await tx.comment.updateMany({
        where: { subjectType: 'contact', subjectId: { in: ids } },
        data: { subjectId: target.id },
      });
      const fallbackEmail = target.email ?? sources.find((s) => s.email !== null)?.email ?? null;
      await tx.contact.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date(), email: null } });
      await tx.contact.update({
        where: { id: target.id },
        data: {
          email: fallbackEmail,
          phone: target.phone ?? sources.find((s) => s.phone !== null)?.phone ?? null,
          title: target.title ?? sources.find((s) => s.title !== null)?.title ?? null,
          companyId: target.companyId ?? sources.find((s) => s.companyId !== null)?.companyId ?? null,
          tags: [...new Set([...target.tags, ...sources.flatMap((s) => s.tags)])],
          custom: {
            ...sources.reduce((a, s) => ({ ...a, ...((s.custom ?? {}) as object) }), {}),
            ...((target.custom ?? {}) as object),
          } as never,
          version: { increment: 1 },
        },
      });
      await tx.activity.create({
        data: {
          tenantId: target.tenantId,
          subjectType: 'contact',
          subjectId: target.id,
          kind: 'merged',
          actorType: 'user',
          data: {
            merged: sources.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), email: s.email })),
          },
        },
      });
      await writeAudit(tx, 'contact.merged', 'contact', target.id, { sources: ids });
      await emitEvent(tx, {
        type: 'contact.updated',
        entity: 'contact',
        entityId: target.id,
        payload: { merged: ids },
      });
      for (const id of ids)
        await emitEvent(tx, {
          type: 'contact.deleted',
          entity: 'contact',
          entityId: id,
          payload: { mergedInto: target.id },
        });
    });
    return this.get(target.id);
  }

  async findDuplicates(): Promise<
    Array<{ key: string; contacts: Array<{ id: string; name: string; email: string | null }> }>
  > {
    const rows = await this.deps.db.scoped.contact.findMany({
      where: { deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      take: 10000,
    });
    const groups = new Map<string, Array<{ id: string; name: string; email: string | null }>>();
    for (const r of rows) {
      const name = `${r.firstName} ${r.lastName}`.trim();
      const keys = [`name:${name.toLowerCase().replace(/\s+/g, ' ')}`];
      if (r.phone !== null && r.phone.replace(/\D/g, '').length >= 7) keys.push(`phone:${r.phone.replace(/\D/g, '')}`);
      for (const key of keys) {
        const list = groups.get(key) ?? [];
        list.push({ id: r.id, name, email: r.email });
        groups.set(key, list);
      }
    }
    return [...groups.entries()].filter(([, v]) => v.length > 1).map(([key, contacts]) => ({ key, contacts }));
  }
}
