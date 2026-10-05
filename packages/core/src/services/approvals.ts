import type { ApprovalCreate, ApprovalDecide, ApprovalDto, Role } from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId } from '../context';
import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from '../errors';
import { emitEvent, writeAudit } from '../events/outbox';
import type { Approval } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import { channels } from '../realtime/publisher';
import { iso, isoRequired } from '../util/json';
import type { Directory } from './directory';
import type { NotificationsService } from './activity';

export type ApprovalDecidedHook = (approval: Approval) => Promise<void>;

export class ApprovalsService {
  private hooks: ApprovalDecidedHook[] = [];

  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
    private readonly notifications: NotificationsService,
  ) {}

  onDecided(hook: ApprovalDecidedHook): void {
    this.hooks.push(hook);
  }

  async toDtos(rows: Approval[]): Promise<ApprovalDto[]> {
    const users = await this.directory.usersById(rows.flatMap((r) => r.assigneeIds));
    return rows.map((a) => ({
      id: a.id,
      source: a.source as ApprovalDto['source'],
      sourceRef: (a.sourceRef ?? {}) as Record<string, unknown>,
      title: a.title,
      details: (a.details ?? {}) as Record<string, unknown>,
      assigneeIds: a.assigneeIds,
      assignees: a.assigneeIds.map((id) => users.get(id)).filter((u): u is NonNullable<typeof u> => u !== undefined),
      status: a.status as ApprovalDto['status'],
      expiresAt: iso(a.expiresAt),
      requestedBy: a.requestedBy,
      callbackUrl: a.callbackUrl,
      decidedBy: a.decidedBy,
      decidedAt: iso(a.decidedAt),
      comment: a.comment,
      createdAt: isoRequired(a.createdAt),
    }));
  }

  async list(status: string | undefined, assignedTo: string | undefined, limit = 100): Promise<ApprovalDto[]> {
    const rows = await this.deps.db.scoped.approval.findMany({
      where: {
        ...(status === undefined ? {} : { status }),
        ...(assignedTo === undefined
          ? {}
          : { OR: [{ assigneeIds: { has: assignedTo } }, { assigneeIds: { isEmpty: true } }] }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return this.toDtos(rows);
  }

  async pendingCount(userId: string): Promise<number> {
    return this.deps.db.scoped.approval.count({
      where: { status: 'pending', OR: [{ assigneeIds: { has: userId } }, { assigneeIds: { isEmpty: true } }] },
    });
  }

  async get(id: string): Promise<ApprovalDto> {
    const row = await this.deps.db.scoped.approval.findFirst({ where: { id } });
    if (row === null) throw notFound('Approval');
    return (await this.toDtos([row]))[0] as ApprovalDto;
  }

  async createInTx(
    tx: Scoped,
    input: {
      source: 'workflow' | 'agent';
      sourceRef: Record<string, unknown>;
      title: string;
      details: Record<string, unknown>;
      assigneeIds: string[];
      expiresAt: Date | null;
      callbackUrl?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<Approval> {
    const ctx = requireContext();
    const approval = await tx.approval.create({
      data: {
        tenantId: ctx.tenantId,
        source: input.source,
        sourceRef: input.sourceRef as never,
        title: input.title,
        details: input.details as never,
        assigneeIds: input.assigneeIds,
        expiresAt: input.expiresAt,
        callbackUrl: input.callbackUrl ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        requestedBy: ctx.actor.type === 'user' ? ctx.actor.id : `${ctx.actor.type}:${ctx.actor.id ?? ''}`,
      },
    });
    await emitEvent(tx, {
      type: 'approval.requested',
      entity: 'approval',
      entityId: approval.id,
      payload: { title: input.title, assigneeIds: input.assigneeIds, source: input.source },
    });
    return approval;
  }

  async afterCreate(approval: Approval): Promise<void> {
    const assignees =
      approval.assigneeIds.length > 0
        ? approval.assigneeIds
        : (await this.directory.byRole('manager')).map((m) => m.id);
    await this.notifications.notify(
      assignees,
      'approval.requested',
      { approvalId: approval.id, title: approval.title, source: approval.source },
      `approval:${approval.id}`,
    );
    await this.deps.realtime.publish(channels.approvals(approval.tenantId), {
      type: 'approval.created',
      id: approval.id,
    });
  }

  async createExternal(input: ApprovalCreate): Promise<ApprovalDto> {
    let assigneeIds = input.assigneeIds ?? [];
    if (assigneeIds.length === 0 && input.assigneeRole !== undefined)
      assigneeIds = (await this.directory.byRole(input.assigneeRole)).map((m) => m.id);
    const known = await this.directory.usersById(assigneeIds);
    if (known.size !== new Set(assigneeIds).size)
      throw validationFailed('Unknown assignees', [{ path: 'assigneeIds', message: 'not members' }]);
    if (input.idempotencyKey !== undefined) {
      const existing = await this.deps.db.scoped.approval.findFirst({
        where: { idempotencyKey: `ext:${requireTenantId()}:${input.idempotencyKey}` },
      });
      if (existing !== null) return this.get(existing.id);
    }
    try {
      const row = await this.deps.db.scoped.$transaction((tx) =>
        this.createInTx(tx, {
          source: 'agent',
          sourceRef: input.sourceRef ?? {},
          title: input.title,
          details: input.details,
          assigneeIds,
          expiresAt: input.expiresInSeconds === undefined ? null : new Date(Date.now() + input.expiresInSeconds * 1000),
          callbackUrl: input.callbackUrl ?? null,
          idempotencyKey:
            input.idempotencyKey === undefined ? null : `ext:${requireTenantId()}:${input.idempotencyKey}`,
        }),
      );
      await this.afterCreate(row);
      return this.get(row.id);
    } catch (error) {
      if (isUniqueViolation(error) && input.idempotencyKey !== undefined) {
        const existing = await this.deps.db.scoped.approval.findFirst({
          where: { idempotencyKey: `ext:${requireTenantId()}:${input.idempotencyKey}` },
        });
        if (existing !== null) return this.get(existing.id);
      }
      throw error;
    }
  }

  async decide(id: string, input: ApprovalDecide, userId: string, role: Role): Promise<ApprovalDto> {
    const current = await this.deps.db.scoped.approval.findFirst({ where: { id } });
    if (current === null) throw notFound('Approval');
    const privileged = role === 'owner' || role === 'admin';
    if (!privileged && current.assigneeIds.length > 0 && !current.assigneeIds.includes(userId))
      throw forbidden('You are not an approver for this request');
    if (current.status !== 'pending')
      throw conflict(`Approval is already ${current.status}`, (await this.toDtos([current]))[0]);
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await this.deps.db.scoped.$transaction(async (tx) => {
      const res = await tx.approval.updateMany({
        where: { id, status: 'pending' },
        data: { status, decidedBy: userId, decidedAt: new Date(), comment: input.comment ?? null },
      });
      if (res.count === 0) throw conflict('Approval was decided concurrently');
      await writeAudit(tx, `approval.${status}`, 'approval', id, { comment: input.comment ?? null });
      await emitEvent(tx, {
        type: 'approval.decided',
        entity: 'approval',
        entityId: id,
        payload: { status, decidedBy: userId, source: current.source },
      });
      return (await tx.approval.findFirst({ where: { id } })) as Approval;
    });
    await this.finish(updated);
    return this.get(id);
  }

  async expire(approval: Approval): Promise<boolean> {
    const res = await this.deps.db.scoped.approval.updateMany({
      where: { id: approval.id, status: 'pending' },
      data: { status: 'expired', decidedAt: new Date() },
    });
    if (res.count === 0) return false;
    const updated = (await this.deps.db.scoped.approval.findFirst({ where: { id: approval.id } })) as Approval;
    await this.finish(updated);
    return true;
  }

  private async finish(approval: Approval): Promise<void> {
    for (const hook of this.hooks) await hook(approval);
    if (approval.callbackUrl !== null) {
      await this.deps.queues.callbacks.add(
        'approval',
        { approvalId: approval.id, tenantId: approval.tenantId },
        {
          attempts: 8,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 500,
          jobId: `approval-cb-${approval.id}`,
        },
      );
    }
    await this.deps.realtime.publish(channels.approvals(approval.tenantId), {
      type: 'approval.decided',
      id: approval.id,
      status: approval.status,
    });
  }

  async cancelForRun(tx: Scoped, runId: string): Promise<void> {
    await tx.approval.updateMany({
      where: { status: 'pending', sourceRef: { path: ['runId'], equals: runId } },
      data: { status: 'cancelled', decidedAt: new Date() },
    });
  }
}
