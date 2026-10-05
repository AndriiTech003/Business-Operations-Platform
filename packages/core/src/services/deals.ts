import {
  fractionalPosition,
  dealCreateSchema,
  type DealCreateInput,
  type DealDto,
  type DealMove,
  type DealUpdate,
  type ForecastDto,
  type ListQuery,
  type Page,
  type PipelineCreate,
  type PipelineDto,
  type StageDto,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { notFound, preconditionFailed, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Deal, Stage } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import { diffObjects, iso, isoRequired, toNumber } from '../util/json';
import type { CustomFieldsService } from './custom-fields';
import type { Directory } from './directory';
import { planList, toPage, type FieldMap } from './query';
import { orderedIdsByCustom } from './custom-sort';
import { COMPANY_REF_SELECT, CONTACT_REF_SELECT, companyRef, contactRef } from './refs';

export const DEAL_FIELDS: FieldMap = {
  title: { kind: 'string', sortable: true },
  amountCents: { kind: 'bigint', sortable: true },
  currency: { kind: 'string' },
  pipelineId: { kind: 'uuid' },
  stageId: { kind: 'uuid' },
  companyId: { kind: 'uuid', nullable: true },
  contactId: { kind: 'uuid', nullable: true },
  ownerId: { kind: 'uuid', nullable: true },
  tags: { kind: 'tags' },
  expectedCloseAt: { kind: 'date', nullable: true, sortable: true },
  stageChangedAt: { kind: 'date', sortable: true },
  lastActivityAt: { kind: 'date', sortable: true },
  closedAt: { kind: 'date', nullable: true, sortable: true },
  position: { kind: 'number', sortable: true },
  createdAt: { kind: 'date', sortable: true },
  updatedAt: { kind: 'date', sortable: true },
};

export function stageDto(s: Stage): StageDto {
  return { id: s.id, name: s.name, position: s.position, probability: s.probability, kind: s.kind };
}

export class DealsService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
    private readonly customFields: CustomFieldsService,
  ) {}

  async pipelines(): Promise<PipelineDto[]> {
    const [pipelines, stages] = await Promise.all([
      this.deps.db.scoped.pipeline.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
      this.deps.db.scoped.stage.findMany({ orderBy: { position: 'asc' } }),
    ]);
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.isDefault,
      stages: stages.filter((s) => s.pipelineId === p.id).map(stageDto),
    }));
  }

  async defaultPipeline(): Promise<PipelineDto> {
    const all = await this.pipelines();
    const p = all[0];
    if (p === undefined) throw notFound('Pipeline');
    return p;
  }

  async createPipeline(input: PipelineCreate): Promise<PipelineDto> {
    const tenantId = requireTenantId();
    const id = await this.deps.db.scoped.$transaction(async (tx) => {
      if (input.isDefault === true) await tx.pipeline.updateMany({ where: {}, data: { isDefault: false } });
      const anyExisting = await tx.pipeline.count();
      const p = await tx.pipeline.create({
        data: { tenantId, name: input.name, isDefault: input.isDefault === true || anyExisting === 0 },
      });
      await tx.stage.createMany({
        data: input.stages.map((s, position) => ({
          tenantId,
          pipelineId: p.id,
          name: s.name,
          probability: s.probability,
          kind: s.kind,
          position,
        })),
      });
      await writeAudit(tx, 'pipeline.created', 'pipeline', p.id, { name: p.name });
      return p.id;
    });
    return (await this.pipelines()).find((p) => p.id === id) as PipelineDto;
  }

  async updatePipeline(id: string, input: PipelineCreate): Promise<PipelineDto> {
    const tenantId = requireTenantId();
    const existing = await this.deps.db.scoped.pipeline.findFirst({ where: { id } });
    if (existing === null) throw notFound('Pipeline');
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.pipeline.update({ where: { id }, data: { name: input.name } });
      if (input.isDefault === true) {
        await tx.pipeline.updateMany({ where: { NOT: { id } }, data: { isDefault: false } });
        await tx.pipeline.update({ where: { id }, data: { isDefault: true } });
      }
      const current = await tx.stage.findMany({ where: { pipelineId: id } });
      const keep = new Set(input.stages.map((s) => s.id).filter((x): x is string => x !== undefined));
      for (const s of current) {
        if (!keep.has(s.id)) {
          const deals = await tx.deal.count({ where: { stageId: s.id, deletedAt: null } });
          if (deals > 0)
            throw validationFailed(`Stage '${s.name}' still has ${deals} deals`, [
              { path: 'stages', message: 'stage in use' },
            ]);
          await tx.stage.delete({ where: { id: s.id } });
        }
      }
      for (const [position, s] of input.stages.entries()) {
        if (s.id !== undefined && current.some((c) => c.id === s.id)) {
          await tx.stage.update({
            where: { id: s.id },
            data: { name: s.name, probability: s.probability, kind: s.kind, position },
          });
        } else {
          await tx.stage.create({
            data: { tenantId, pipelineId: id, name: s.name, probability: s.probability, kind: s.kind, position },
          });
        }
      }
      await writeAudit(tx, 'pipeline.updated', 'pipeline', id, { stages: input.stages.length });
    });
    return (await this.pipelines()).find((p) => p.id === id) as PipelineDto;
  }

  async toDtos(rows: Deal[]): Promise<DealDto[]> {
    const stageIds = [...new Set(rows.map((r) => r.stageId))];
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => x !== null))];
    const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => x !== null))];
    const [stages, companies, contacts, users] = await Promise.all([
      stageIds.length === 0 ? [] : this.deps.db.scoped.stage.findMany({ where: { id: { in: stageIds } } }),
      companyIds.length === 0
        ? []
        : this.deps.db.scoped.company.findMany({ where: { id: { in: companyIds } }, select: COMPANY_REF_SELECT }),
      contactIds.length === 0
        ? []
        : this.deps.db.scoped.contact.findMany({
            where: { id: { in: contactIds } },
            select: CONTACT_REF_SELECT,
          }),
      this.directory.usersById(rows.map((r) => r.ownerId)),
    ]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const companyById = new Map(companies.map((c) => [c.id, companyRef(c)]));
    const contactById = new Map(contacts.map((c) => [c.id, contactRef(c)]));
    return rows.map((d) => {
      const stage = stageById.get(d.stageId);
      return {
        id: d.id,
        title: d.title,
        pipelineId: d.pipelineId,
        stageId: d.stageId,
        stage: stage === undefined ? null : stageDto(stage),
        companyId: d.companyId,
        company: d.companyId === null ? null : (companyById.get(d.companyId) ?? null),
        contactId: d.contactId,
        contact: d.contactId === null ? null : (contactById.get(d.contactId) ?? null),
        amountCents: toNumber(d.amountCents),
        currency: d.currency,
        expectedCloseAt: iso(d.expectedCloseAt),
        ownerId: d.ownerId,
        owner: d.ownerId === null ? null : (users.get(d.ownerId) ?? null),
        position: d.position,
        custom: (d.custom ?? {}) as Record<string, unknown>,
        tags: d.tags,
        stageChangedAt: isoRequired(d.stageChangedAt),
        lastActivityAt: isoRequired(d.lastActivityAt),
        closedAt: iso(d.closedAt),
        lostReason: d.lostReason,
        version: d.version,
        createdAt: isoRequired(d.createdAt),
        updatedAt: isoRequired(d.updatedAt),
      };
    });
  }

  async list(query: ListQuery): Promise<Page<DealDto>> {
    const customTypes = await this.customFields.typesFor('deal');
    const plan = planList(query, DEAL_FIELDS, customTypes, { deletedAt: null }, 'position', ['title']);
    let rows: Deal[];
    if (plan.customSort !== null) {
      const ids = await orderedIdsByCustom(this.deps, 'deal', plan, query.limit);
      const found = await this.deps.db.scoped.deal.findMany({ where: { id: { in: ids } } });
      const byId = new Map(found.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter((r): r is Deal => r !== undefined);
    } else {
      rows = await this.deps.db.scoped.deal.findMany({
        where: plan.where as never,
        orderBy: plan.orderBy as never,
        take: plan.take,
        skip: plan.skip,
      });
    }
    const dtos = await this.toDtos(rows);
    const byId = new Map(dtos.map((d) => [d.id, d]));
    return toPage(rows, plan, query.limit, (r) => byId.get(r.id) as DealDto);
  }

  async board(pipelineId?: string): Promise<{ pipeline: PipelineDto; deals: DealDto[] }> {
    const pipelines = await this.pipelines();
    const pipeline = pipelineId === undefined ? pipelines[0] : pipelines.find((p) => p.id === pipelineId);
    if (pipeline === undefined) throw notFound('Pipeline');
    const rows = await this.deps.db.scoped.deal.findMany({
      where: { pipelineId: pipeline.id, deletedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: 2000,
    });
    return { pipeline, deals: await this.toDtos(rows) };
  }

  async getRow(id: string): Promise<Deal> {
    const row = await this.deps.db.scoped.deal.findFirst({ where: { id, deletedAt: null } });
    if (row === null) throw notFound('Deal');
    return row;
  }

  async get(id: string): Promise<DealDto> {
    return (await this.toDtos([await this.getRow(id)]))[0] as DealDto;
  }

  private async stage(stageId: string): Promise<Stage> {
    const s = await this.deps.db.scoped.stage.findFirst({ where: { id: stageId } });
    if (s === null) throw validationFailed('Unknown stage', [{ path: 'stageId', message: 'unknown stage' }]);
    return s;
  }

  private async assertRefs(input: {
    ownerId?: string | null;
    companyId?: string | null;
    contactId?: string | null;
  }): Promise<void> {
    if (input.ownerId !== null && input.ownerId !== undefined && !(await this.directory.isMember(input.ownerId))) {
      throw validationFailed('Owner must be a member of the workspace', [{ path: 'ownerId', message: 'unknown user' }]);
    }
    if (
      input.companyId !== null &&
      input.companyId !== undefined &&
      (await this.deps.db.scoped.company.count({ where: { id: input.companyId, deletedAt: null } })) === 0
    ) {
      throw validationFailed('Company not found', [{ path: 'companyId', message: 'unknown company' }]);
    }
    if (
      input.contactId !== null &&
      input.contactId !== undefined &&
      (await this.deps.db.scoped.contact.count({ where: { id: input.contactId, deletedAt: null } })) === 0
    ) {
      throw validationFailed('Contact not found', [{ path: 'contactId', message: 'unknown contact' }]);
    }
  }

  async create(raw: DealCreateInput): Promise<DealDto> {
    const input = dealCreateSchema.parse(raw);
    const tenantId = requireTenantId();
    await this.assertRefs(input);
    const pipeline =
      input.pipelineId === undefined
        ? await this.defaultPipeline()
        : (await this.pipelines()).find((p) => p.id === input.pipelineId);
    if (pipeline === undefined)
      throw validationFailed('Unknown pipeline', [{ path: 'pipelineId', message: 'unknown pipeline' }]);
    const stageId = input.stageId ?? pipeline.stages[0]?.id;
    if (stageId === undefined || !pipeline.stages.some((s) => s.id === stageId))
      throw validationFailed('Unknown stage', [{ path: 'stageId', message: 'stage not in pipeline' }]);
    const custom = await this.customFields.validate('deal', input.custom, false);
    const row = await this.deps.db.scoped.$transaction(async (tx) => {
      const last = await tx.deal.findFirst({
        where: { stageId, deletedAt: null },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const created = await tx.deal.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          stageId,
          title: input.title,
          companyId: input.companyId ?? null,
          contactId: input.contactId ?? null,
          amountCents: BigInt(input.amountCents),
          currency: input.currency,
          expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
          ownerId: input.ownerId ?? null,
          position: fractionalPosition(last?.position ?? null, null),
          custom: custom as never,
          tags: input.tags ?? [],
        },
      });
      await writeAudit(tx, 'deal.created', 'deal', created.id, { after: created });
      await emitEvent(tx, {
        type: 'deal.created',
        entity: 'deal',
        entityId: created.id,
        payload: { title: created.title, stageId, amountCents: input.amountCents },
      });
      return created;
    });
    return this.get(row.id);
  }

  async update(id: string, input: DealUpdate, expectedVersion?: number): Promise<DealDto> {
    const current = await this.getRow(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw preconditionFailed(await this.get(id));
    await this.assertRefs(input);
    const custom =
      input.custom === undefined
        ? undefined
        : {
            ...((current.custom ?? {}) as Record<string, unknown>),
            ...(await this.customFields.validate('deal', input.custom, true)),
          };
    let stage: Stage | null = null;
    if (input.stageId !== undefined && input.stageId !== null && input.stageId !== current.stageId) {
      stage = await this.stage(input.stageId);
      if (stage.pipelineId !== current.pipelineId)
        throw validationFailed('Stage belongs to another pipeline', [{ path: 'stageId', message: 'wrong pipeline' }]);
    }
    await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.deal.updateMany({
        where: { id, version: current.version },
        data: {
          title: input.title,
          companyId: input.companyId,
          contactId: input.contactId,
          amountCents: input.amountCents === undefined ? undefined : BigInt(input.amountCents),
          currency: input.currency,
          expectedCloseAt:
            input.expectedCloseAt === undefined
              ? undefined
              : input.expectedCloseAt === null
                ? null
                : new Date(input.expectedCloseAt),
          ownerId: input.ownerId,
          lostReason: input.lostReason,
          custom: custom as never,
          tags: input.tags,
          version: { increment: 1 },
          lastActivityAt: new Date(),
        },
      });
      if (res.count === 0) throw preconditionFailed(null);
      if (stage !== null) await this.applyStageChange(tx, current, stage, current.position, input.lostReason ?? null);
      const updated = (await tx.deal.findFirst({ where: { id } })) as Deal;
      const changes = diffObjects(
        current as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      delete changes['lastActivityAt'];
      await writeAudit(tx, 'deal.updated', 'deal', id, changes);
      if (Object.keys(changes).length > 0)
        await emitEvent(tx, { type: 'deal.updated', entity: 'deal', entityId: id, payload: { changes } });
    });
    return this.get(id);
  }

  private async applyStageChange(
    tx: Scoped,
    current: Deal,
    stage: Stage,
    position: number,
    lostReason: string | null,
  ): Promise<void> {
    const now = new Date();
    const fromStage = await tx.stage.findFirst({ where: { id: current.stageId } });
    await tx.deal.update({
      where: { id: current.id },
      data: {
        stageId: stage.id,
        position,
        stageChangedAt: now,
        closedAt: stage.kind === 'open' ? null : now,
        lostReason: stage.kind === 'lost' ? (lostReason ?? current.lostReason) : null,
      },
    });
    const payload = {
      fromStageId: current.stageId,
      fromStage: fromStage?.name ?? null,
      toStageId: stage.id,
      toStage: stage.name,
      kind: stage.kind,
      position,
      title: current.title,
      amountCents: toNumber(current.amountCents),
      lostReason,
    };
    await emitEvent(tx, { type: 'deal.stage_changed', entity: 'deal', entityId: current.id, payload });
    if (stage.kind === 'won' && fromStage?.kind !== 'won')
      await emitEvent(tx, { type: 'deal.won', entity: 'deal', entityId: current.id, payload });
    if (stage.kind === 'lost' && fromStage?.kind !== 'lost')
      await emitEvent(tx, { type: 'deal.lost', entity: 'deal', entityId: current.id, payload });
  }

  async move(id: string, input: DealMove, expectedVersion?: number): Promise<DealDto> {
    const current = await this.getRow(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw preconditionFailed(await this.get(id));
    const stage = await this.stage(input.stageId);
    if (stage.pipelineId !== current.pipelineId)
      throw validationFailed('Stage belongs to another pipeline', [{ path: 'stageId', message: 'wrong pipeline' }]);
    if (
      stage.kind === 'lost' &&
      (input.lostReason === undefined || input.lostReason === null || input.lostReason.trim() === '') &&
      current.stageId !== stage.id
    ) {
      throw validationFailed('A reason is required when a deal is lost', [{ path: 'lostReason', message: 'required' }]);
    }
    await this.deps.db.scoped.$transaction(async (tx) => {
      const neighbours = async (nid: string | null | undefined): Promise<number | null> => {
        if (nid === null || nid === undefined) return null;
        const n = await tx.deal.findFirst({ where: { id: nid, stageId: stage.id }, select: { position: true } });
        return n?.position ?? null;
      };
      let before = await neighbours(input.beforeId);
      let after = await neighbours(input.afterId);
      if (before === null && after === null && input.beforeId == null && input.afterId == null) {
        const last = await tx.deal.findFirst({
          where: { stageId: stage.id, deletedAt: null, NOT: { id } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        before = last?.position ?? null;
      }
      if (before !== null && after !== null && Math.abs(after - before) < 1e-6) {
        await this.rebalance(tx, stage.id);
        before = await neighbours(input.beforeId);
        after = await neighbours(input.afterId);
      }
      const position = fractionalPosition(before, after);
      const reason = input.lostReason?.trim() ?? '';
      const newReason =
        stage.id === current.stageId && stage.kind === 'lost' && reason !== '' && reason !== current.lostReason
          ? reason
          : null;
      const res = await tx.deal.updateMany({
        where: { id, version: current.version },
        data: {
          version: { increment: 1 },
          position,
          lastActivityAt: new Date(),
          ...(newReason === null ? {} : { lostReason: newReason }),
        },
      });
      if (res.count === 0) throw preconditionFailed(null);
      if (stage.id !== current.stageId) {
        await this.applyStageChange(tx, current, stage, position, input.lostReason ?? null);
        await writeAudit(tx, 'deal.moved', 'deal', id, { stageId: { from: current.stageId, to: stage.id } });
      } else {
        if (newReason !== null)
          await writeAudit(tx, 'deal.updated', 'deal', id, {
            lostReason: { from: current.lostReason, to: newReason },
          });
        await emitEvent(tx, {
          type: 'deal.updated',
          entity: 'deal',
          entityId: id,
          payload: {
            changes: {
              position: { from: current.position, to: position },
              ...(newReason === null ? {} : { lostReason: { from: current.lostReason, to: newReason } }),
            },
            reorder: newReason === null,
          },
        });
      }
    });
    return this.get(id);
  }

  private async rebalance(tx: Scoped, stageId: string): Promise<void> {
    const rows = await tx.deal.findMany({
      where: { stageId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    for (const [i, r] of rows.entries())
      await tx.deal.update({ where: { id: r.id }, data: { position: (i + 1) * 1024 } });
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.deps.db.scoped.$transaction(async (tx) => {
      await tx.deal.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      await writeAudit(tx, 'deal.deleted', 'deal', id, {});
      await emitEvent(tx, { type: 'deal.deleted', entity: 'deal', entityId: id });
    });
  }

  async forecast(pipelineId?: string): Promise<ForecastDto> {
    const pipelines = await this.pipelines();
    const pipeline = pipelineId === undefined ? pipelines[0] : pipelines.find((p) => p.id === pipelineId);
    if (pipeline === undefined) throw notFound('Pipeline');
    const deals = await this.deps.db.scoped.deal.findMany({
      where: { pipelineId: pipeline.id, deletedAt: null, closedAt: null },
      select: { amountCents: true, stageId: true, expectedCloseAt: true, currency: true },
    });
    const stageById = new Map(pipeline.stages.map((s) => [s.id, s]));
    const months = new Map<string, { totalCents: number; weightedCents: number; deals: number }>();
    const byStage = new Map<string, { totalCents: number; weightedCents: number; deals: number }>();
    let total = 0;
    let weighted = 0;
    for (const d of deals) {
      const amount = toNumber(d.amountCents);
      const prob = (stageById.get(d.stageId)?.probability ?? 0) / 100;
      const w = Math.round(amount * prob);
      total += amount;
      weighted += w;
      const month = (d.expectedCloseAt ?? new Date()).toISOString().slice(0, 7);
      const m = months.get(month) ?? { totalCents: 0, weightedCents: 0, deals: 0 };
      m.totalCents += amount;
      m.weightedCents += w;
      m.deals += 1;
      months.set(month, m);
      const s = byStage.get(d.stageId) ?? { totalCents: 0, weightedCents: 0, deals: 0 };
      s.totalCents += amount;
      s.weightedCents += w;
      s.deals += 1;
      byStage.set(d.stageId, s);
    }
    const tenant = await this.deps.db.system.tenant.findUnique({ where: { id: requireTenantId() } });
    return {
      currency: ((tenant?.settings ?? {}) as { currency?: string }).currency ?? 'USD',
      months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
      byStage: pipeline.stages
        .filter((s) => s.kind === 'open')
        .map((s) => ({
          stageId: s.id,
          name: s.name,
          probability: s.probability,
          ...(byStage.get(s.id) ?? { totalCents: 0, weightedCents: 0, deals: 0 }),
        })),
      totalCents: total,
      weightedCents: weighted,
    };
  }
}
