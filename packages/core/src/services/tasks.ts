import {
  taskCreateSchema,
  type ListQuery,
  type Page,
  type SubjectType,
  type TaskCreate,
  type TaskCreateInput,
  type TaskDto,
  type TaskUpdate,
} from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId } from '../context';
import { isUniqueViolation, notFound, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Task } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import { diffObjects, iso, isoRequired } from '../util/json';
import type { Directory } from './directory';
import { COMPANY_REF_SELECT, CONTACT_REF_SELECT, companyRef, contactRef } from './refs';
import { planList, toPage, type FieldMap } from './query';

export const TASK_FIELDS: FieldMap = {
  title: { kind: 'string', sortable: true },
  status: { kind: 'enum', sortable: true },
  priority: { kind: 'number', sortable: true },
  assigneeId: { kind: 'uuid', nullable: true },
  dueAt: { kind: 'date', nullable: true, sortable: true },
  relatedType: { kind: 'string', nullable: true },
  relatedId: { kind: 'uuid', nullable: true },
  createdByType: { kind: 'string' },
  createdAt: { kind: 'date', sortable: true },
  updatedAt: { kind: 'date', sortable: true },
};

export class TasksService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
  ) {}

  async relatedTitles(
    rows: Array<{ relatedType: string | null; relatedId: string | null }>,
  ): Promise<Map<string, { title: string; external: boolean }>> {
    const out = new Map<string, { title: string; external: boolean }>();
    const ids = (type: string) => [
      ...new Set(rows.filter((r) => r.relatedType === type && r.relatedId !== null).map((r) => r.relatedId as string)),
    ];
    const db = this.deps.db.scoped;
    const [companies, contacts, deals, invoices] = await Promise.all([
      ids('company').length
        ? db.company.findMany({ where: { id: { in: ids('company') } }, select: COMPANY_REF_SELECT })
        : [],
      ids('contact').length
        ? db.contact.findMany({
            where: { id: { in: ids('contact') } },
            select: CONTACT_REF_SELECT,
          })
        : [],
      ids('deal').length
        ? db.deal.findMany({ where: { id: { in: ids('deal') } }, select: { id: true, title: true } })
        : [],
      ids('invoice').length
        ? db.invoice.findMany({ where: { id: { in: ids('invoice') } }, select: { id: true, number: true } })
        : [],
    ]);
    for (const c of companies) out.set(c.id, { title: c.name, external: companyRef(c).untrusted !== undefined });
    for (const c of contacts) {
      const ref = contactRef(c);
      out.set(c.id, { title: ref.name, external: ref.untrusted !== undefined });
    }
    for (const d of deals) out.set(d.id, { title: d.title, external: false });
    for (const i of invoices) out.set(i.id, { title: i.number, external: false });
    return out;
  }

  async toDtos(rows: Task[]): Promise<TaskDto[]> {
    const [users, titles] = await Promise.all([
      this.directory.usersById(rows.map((r) => r.assigneeId)),
      this.relatedTitles(rows),
    ]);
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      assigneeId: t.assigneeId,
      assignee: t.assigneeId === null ? null : (users.get(t.assigneeId) ?? null),
      dueAt: iso(t.dueAt),
      status: t.status,
      priority: t.priority,
      relatedType: t.relatedType as SubjectType | null,
      relatedId: t.relatedId,
      related:
        t.relatedType !== null && t.relatedId !== null
          ? {
              type: t.relatedType as SubjectType,
              id: t.relatedId,
              title: titles.get(t.relatedId)?.title ?? t.relatedType,
              ...(titles.get(t.relatedId)?.external === true ? { untrusted: ['title'] } : {}),
            }
          : null,
      createdByType: t.createdByType as TaskDto['createdByType'],
      createdById: t.createdById,
      completedAt: iso(t.completedAt),
      createdAt: isoRequired(t.createdAt),
      updatedAt: isoRequired(t.updatedAt),
    }));
  }

  async list(query: ListQuery, base: Record<string, unknown> = {}): Promise<Page<TaskDto>> {
    const plan = planList(query, TASK_FIELDS, {}, base, 'dueAt', ['title', 'description']);
    const rows = await this.deps.db.scoped.task.findMany({
      where: plan.where as never,
      orderBy: plan.orderBy as never,
      take: plan.take,
      skip: plan.skip,
    });
    const dtos = await this.toDtos(rows);
    const byId = new Map(dtos.map((d) => [d.id, d]));
    return toPage(rows, plan, query.limit, (r) => byId.get(r.id) as TaskDto);
  }

  async my(userId: string, query: ListQuery): Promise<Page<TaskDto>> {
    return this.list(query, { assigneeId: userId, status: { in: ['open', 'in_progress'] } });
  }

  async get(id: string): Promise<TaskDto> {
    const row = await this.deps.db.scoped.task.findFirst({ where: { id } });
    if (row === null) throw notFound('Task');
    return (await this.toDtos([row]))[0] as TaskDto;
  }

  async assertRelated(type: string | null | undefined, id: string | null | undefined): Promise<void> {
    if (type === null || type === undefined || id === null || id === undefined) return;
    const db = this.deps.db.scoped;
    const count =
      type === 'company'
        ? await db.company.count({ where: { id } })
        : type === 'contact'
          ? await db.contact.count({ where: { id } })
          : type === 'deal'
            ? await db.deal.count({ where: { id } })
            : type === 'invoice'
              ? await db.invoice.count({ where: { id } })
              : await db.task.count({ where: { id } });
    if (count === 0)
      throw validationFailed('Related record not found', [{ path: 'relatedId', message: 'unknown record' }]);
  }

  async createInTx(tx: Scoped, input: TaskCreate, idempotencyKey: string | null): Promise<Task> {
    const ctx = requireContext();
    const created = await tx.task.create({
      data: {
        tenantId: requireTenantId(),
        title: input.title,
        description: input.description ?? null,
        assigneeId: input.assigneeId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        priority: input.priority,
        status: input.status ?? 'open',
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
        idempotencyKey,
      },
    });
    await writeAudit(tx, 'task.created', 'task', created.id, { title: created.title });
    await emitEvent(tx, {
      type: 'task.created',
      entity: 'task',
      entityId: created.id,
      payload: {
        title: created.title,
        assigneeId: created.assigneeId,
        relatedType: created.relatedType,
        relatedId: created.relatedId,
      },
    });
    return created;
  }

  async create(raw: TaskCreateInput, idempotencyKey: string | null = null): Promise<TaskDto> {
    const input = taskCreateSchema.parse(raw);
    if (input.assigneeId && !(await this.directory.isMember(input.assigneeId))) {
      throw validationFailed('Assignee must be a member of the workspace', [
        { path: 'assigneeId', message: 'unknown user' },
      ]);
    }
    await this.assertRelated(input.relatedType, input.relatedId);
    try {
      const row = await this.deps.db.scoped.$transaction((tx) => this.createInTx(tx, input, idempotencyKey));
      return this.get(row.id);
    } catch (error) {
      if (idempotencyKey !== null && isUniqueViolation(error)) {
        const existing = await this.deps.db.scoped.task.findFirst({ where: { idempotencyKey } });
        if (existing !== null) return this.get(existing.id);
      }
      throw error;
    }
  }

  async update(id: string, input: TaskUpdate): Promise<TaskDto> {
    const current = await this.deps.db.scoped.task.findFirst({ where: { id } });
    if (current === null) throw notFound('Task');
    if (input.assigneeId && !(await this.directory.isMember(input.assigneeId))) {
      throw validationFailed('Assignee must be a member of the workspace', [
        { path: 'assigneeId', message: 'unknown user' },
      ]);
    }
    const completing = input.status === 'done' && current.status !== 'done';
    await this.deps.db.scoped.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data: {
          title: input.title,
          description: input.description,
          assigneeId: input.assigneeId,
          dueAt: input.dueAt === undefined ? undefined : input.dueAt === null ? null : new Date(input.dueAt),
          priority: input.priority,
          status: input.status,
          relatedType: input.relatedType,
          relatedId: input.relatedId,
          completedAt: completing
            ? new Date()
            : input.status !== undefined && input.status !== 'done'
              ? null
              : undefined,
          remindedAt: input.dueAt !== undefined ? null : undefined,
        },
      });
      const changes = diffObjects(
        current as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      await writeAudit(tx, 'task.updated', 'task', id, changes);
      await emitEvent(tx, {
        type: completing ? 'task.completed' : 'task.updated',
        entity: 'task',
        entityId: id,
        payload: { title: updated.title, changes, relatedType: updated.relatedType, relatedId: updated.relatedId },
      });
    });
    return this.get(id);
  }

  async bulkComplete(ids: string[]): Promise<{ completed: number }> {
    let completed = 0;
    for (const id of ids) {
      const row = await this.deps.db.scoped.task.findFirst({ where: { id } });
      if (row === null || row.status === 'done') continue;
      await this.update(id, { status: 'done' });
      completed += 1;
    }
    return { completed };
  }

  async remove(id: string): Promise<void> {
    const res = await this.deps.db.scoped.task.deleteMany({ where: { id } });
    if (res.count === 0) throw notFound('Task');
    await writeAudit(this.deps.db.scoped, 'task.deleted', 'task', id, {});
  }

  async forRecord(type: string, id: string): Promise<TaskDto[]> {
    const rows = await this.deps.db.scoped.task.findMany({
      where: { relatedType: type, relatedId: id },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 200,
    });
    return this.toDtos(rows);
  }
}
