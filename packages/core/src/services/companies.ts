import {
  companyCreateSchema,
  companyUntrustedFields,
  companyUpdateSchema,
  type CompanyCreate,
  type CompanyDto,
  type CompanyUpdate,
  type ListQuery,
  type MergeInput,
  type Page,
  type UserSummary,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { notFound, preconditionFailed, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Company } from '../generated/prisma/client';
import { diffObjects, isoRequired, toNumber } from '../util/json';
import type { CustomFieldsService } from './custom-fields';
import type { Directory } from './directory';
import { planList, toPage, type FieldMap } from './query';
import { orderedIdsByCustom } from './custom-sort';

export const COMPANY_FIELDS: FieldMap = {
  name: { kind: 'string', sortable: true },
  domain: { kind: 'string', nullable: true, sortable: true },
  industry: { kind: 'string', nullable: true, sortable: true },
  size: { kind: 'number', nullable: true, sortable: true },
  ownerId: { kind: 'uuid', nullable: true },
  tags: { kind: 'tags' },
  createdAt: { kind: 'date', sortable: true },
  updatedAt: { kind: 'date', sortable: true },
};

export function companyDto(c: Company, users: Map<string, UserSummary>): CompanyDto {
  return {
    id: c.id,
    name: c.name,
    domain: c.domain,
    industry: c.industry,
    size: c.size,
    ownerId: c.ownerId,
    owner: c.ownerId === null ? null : (users.get(c.ownerId) ?? null),
    custom: (c.custom ?? {}) as Record<string, unknown>,
    tags: c.tags,
    source: c.source,
    version: c.version,
    createdAt: isoRequired(c.createdAt),
    updatedAt: isoRequired(c.updatedAt),
    untrusted: companyUntrustedFields(c),
  };
}

export class CompaniesService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
    private readonly customFields: CustomFieldsService,
  ) {}

  private async assertOwner(ownerId: string | null | undefined): Promise<void> {
    if (ownerId === null || ownerId === undefined) return;
    if (!(await this.directory.isMember(ownerId)))
      throw validationFailed('Owner must be a member of the workspace', [{ path: 'ownerId', message: 'unknown user' }]);
  }

  async list(query: ListQuery): Promise<Page<CompanyDto>> {
    const customTypes = await this.customFields.typesFor('company');
    const plan = planList(query, COMPANY_FIELDS, customTypes, { deletedAt: null }, 'name', [
      'name',
      'domain',
      'industry',
    ]);
    let rows: Company[];
    if (plan.customSort !== null) {
      const ids = await orderedIdsByCustom(this.deps, 'company', plan, query.limit);
      const found = await this.deps.db.scoped.company.findMany({ where: { id: { in: ids } } });
      const byId = new Map(found.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter((r): r is Company => r !== undefined);
    } else {
      rows = await this.deps.db.scoped.company.findMany({
        where: plan.where as never,
        orderBy: plan.orderBy as never,
        take: plan.take,
        skip: plan.skip,
      });
    }
    const users = await this.directory.usersById(rows.map((r) => r.ownerId));
    return toPage(rows, plan, query.limit, (r) => companyDto(r, users));
  }

  async getRow(id: string): Promise<Company> {
    const row = await this.deps.db.scoped.company.findFirst({ where: { id, deletedAt: null } });
    if (row === null) throw notFound('Company');
    return row;
  }

  async get(id: string): Promise<CompanyDto> {
    const row = await this.getRow(id);
    const users = await this.directory.usersById([row.ownerId]);
    const dto = companyDto(row, users);
    const [contacts, openDeals, invoices] = await Promise.all([
      this.deps.db.scoped.contact.count({ where: { companyId: id, deletedAt: null } }),
      this.deps.db.scoped.deal.aggregate({
        where: { companyId: id, closedAt: null, deletedAt: null },
        _count: true,
        _sum: { amountCents: true },
      }),
      this.deps.db.scoped.invoice.aggregate({
        where: { companyId: id, status: { in: ['sent', 'partially_paid', 'overdue'] } },
        _sum: { totalCents: true, paidCents: true },
      }),
    ]);
    dto.stats = {
      contacts,
      openDeals: openDeals._count,
      openDealsCents: toNumber(openDeals._sum.amountCents),
      unpaidInvoicesCents: toNumber(invoices._sum.totalCents) - toNumber(invoices._sum.paidCents),
    };
    return dto;
  }

  async create(raw: CompanyCreate): Promise<CompanyDto> {
    const parsed = companyCreateSchema.safeParse(raw);
    if (!parsed.success)
      throw validationFailed(
        'Invalid company',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const input = parsed.data;
    const tenantId = requireTenantId();
    await this.assertOwner(input.ownerId);
    const custom = await this.customFields.validate('company', input.custom, false);
    const row = await this.deps.db.scoped.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          tenantId,
          name: input.name,
          domain: input.domain ?? null,
          industry: input.industry ?? null,
          size: input.size ?? null,
          ownerId: input.ownerId ?? null,
          source: input.source ?? null,
          custom: custom as never,
          tags: input.tags ?? [],
        },
      });
      await writeAudit(tx, 'company.created', 'company', created.id, { after: created });
      await emitEvent(tx, {
        type: 'company.created',
        entity: 'company',
        entityId: created.id,
        payload: { name: created.name },
      });
      return created;
    });
    return companyDto(row, await this.directory.usersById([row.ownerId]));
  }

  async update(id: string, raw: CompanyUpdate, expectedVersion?: number): Promise<CompanyDto> {
    const parsedUpdate = companyUpdateSchema.safeParse(raw);
    if (!parsedUpdate.success)
      throw validationFailed(
        'Invalid company',
        parsedUpdate.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const input = parsedUpdate.data;
    const current = await this.getRow(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw preconditionFailed(companyDto(current, await this.directory.usersById([current.ownerId])));
    }
    await this.assertOwner(input.ownerId);
    const custom =
      input.custom === undefined
        ? undefined
        : {
            ...((current.custom ?? {}) as Record<string, unknown>),
            ...(await this.customFields.validate('company', input.custom, true)),
          };
    const row = await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.company.updateMany({
        where: { id, version: current.version },
        data: {
          name: input.name,
          domain: input.domain,
          industry: input.industry,
          size: input.size,
          ownerId: input.ownerId,
          source: input.source,
          custom: custom as never,
          tags: input.tags,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) {
        const latest = await tx.company.findFirst({ where: { id } });
        throw preconditionFailed(latest === null ? null : companyDto(latest, new Map()));
      }
      const updated = (await tx.company.findFirst({ where: { id } })) as Company;
      const changes = diffObjects(
        current as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      await writeAudit(tx, 'company.updated', 'company', id, changes);
      if (Object.keys(changes).length > 0) {
        await emitEvent(tx, { type: 'company.updated', entity: 'company', entityId: id, payload: { changes } });
      }
      return updated;
    });
    return companyDto(row, await this.directory.usersById([row.ownerId]));
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.company.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      await writeAudit(tx, 'company.deleted', 'company', id, {});
      await emitEvent(tx, { type: 'company.deleted', entity: 'company', entityId: id });
    });
  }

  async merge(input: MergeInput): Promise<CompanyDto> {
    const target = await this.getRow(input.targetId);
    const sources = await this.deps.db.scoped.company.findMany({
      where: { id: { in: input.sourceIds }, deletedAt: null },
    });
    if (sources.length !== input.sourceIds.length || input.sourceIds.includes(target.id)) {
      throw validationFailed('Invalid merge request', [{ path: 'sourceIds', message: 'unknown or same as target' }]);
    }
    const ids = sources.map((s) => s.id);
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { companyId: { in: ids } }, data: { companyId: target.id } });
      await tx.deal.updateMany({ where: { companyId: { in: ids } }, data: { companyId: target.id } });
      await tx.invoice.updateMany({ where: { companyId: { in: ids } }, data: { companyId: target.id } });
      await tx.task.updateMany({
        where: { relatedType: 'company', relatedId: { in: ids } },
        data: { relatedId: target.id },
      });
      await tx.activity.updateMany({
        where: { subjectType: 'company', subjectId: { in: ids } },
        data: { subjectId: target.id },
      });
      await tx.comment.updateMany({
        where: { subjectType: 'company', subjectId: { in: ids } },
        data: { subjectId: target.id },
      });
      const tags = [...new Set([...target.tags, ...sources.flatMap((s) => s.tags)])];
      const custom = {
        ...sources.reduce((acc, s) => ({ ...acc, ...((s.custom ?? {}) as object) }), {}),
        ...((target.custom ?? {}) as object),
      };
      await tx.company.update({
        where: { id: target.id },
        data: {
          tags,
          custom: custom as never,
          domain: target.domain ?? sources.find((s) => s.domain !== null)?.domain ?? null,
          industry: target.industry ?? sources.find((s) => s.industry !== null)?.industry ?? null,
          version: { increment: 1 },
        },
      });
      await tx.company.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
      await tx.activity.create({
        data: {
          tenantId: target.tenantId,
          subjectType: 'company',
          subjectId: target.id,
          kind: 'merged',
          actorType: 'user',
          data: { merged: sources.map((s) => ({ id: s.id, name: s.name })) },
        },
      });
      await writeAudit(tx, 'company.merged', 'company', target.id, { sources: ids });
      await emitEvent(tx, {
        type: 'company.updated',
        entity: 'company',
        entityId: target.id,
        payload: { merged: ids },
      });
      for (const id of ids)
        await emitEvent(tx, {
          type: 'company.deleted',
          entity: 'company',
          entityId: id,
          payload: { mergedInto: target.id },
        });
    });
    return this.get(target.id);
  }

  async findDuplicates(): Promise<
    Array<{ key: string; companies: Array<{ id: string; name: string; domain: string | null }> }>
  > {
    const rows = await this.deps.db.scoped.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, domain: true },
      take: 5000,
    });
    const groups = new Map<string, Array<{ id: string; name: string; domain: string | null }>>();
    for (const r of rows) {
      const key =
        r.domain !== null && r.domain !== ''
          ? `domain:${r.domain.toLowerCase()}`
          : `name:${r.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return [...groups.entries()].filter(([, v]) => v.length > 1).map(([key, companies]) => ({ key, companies }));
  }
}
