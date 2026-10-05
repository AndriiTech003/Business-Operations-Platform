import type { DomainEvent, TriggerEntity } from '@bop/contracts';
import type { Logger } from 'pino';
import { runInContext } from '../context';
import type { CoreDeps } from '../deps';
import type { Engine } from '../engine/engine';
import type { RunsService } from '../engine/runs';
import { channels } from '../realtime/publisher';
import type { ActivityService, NotificationsService } from '../services/activity';
import type { ApprovalsService } from '../services/approvals';
import type { SearchService } from '../services/reports';

const INDEXED = new Set<TriggerEntity>(['company', 'contact', 'deal', 'invoice', 'task']);
const NO_ACTIVITY = new Set(['note.added', 'approval.requested', 'approval.decided', 'workflow.run_finished']);

export class EventConsumer {
  private readonly log: Logger;

  constructor(
    private readonly deps: CoreDeps,
    private readonly search: SearchService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly runs: RunsService,
    private readonly engine: Engine,
  ) {
    this.log = deps.logger.child({ component: 'events' });
  }

  async handle(outboxId: string): Promise<void> {
    const row = await this.deps.db.system.outbox.findUnique({ where: { id: outboxId } });
    if (row === null) return;
    const event = row.payload as unknown as DomainEvent;
    await runInContext({ tenantId: row.tenantId, actor: event.actor, causation: event.causation ?? [] }, async () => {
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['search', () => this.index(event)],
        ['activity', () => this.recordActivity(event)],
        ['notifications', () => this.notify(event)],
        ['workflow-triggers', () => this.runs.onEvent(event)],
        [
          'wait-for-event',
          () => this.engine.resumeEvent(event.tenantId, event.entity, event.entityId, event.type, event.payload),
        ],
        ['realtime', () => this.realtime(event)],
      ];
      const failures: string[] = [];
      for (const [name, fn] of steps) {
        try {
          await fn();
        } catch (error) {
          failures.push(name);
          this.log.error({ err: error, eventId: event.id, type: event.type, step: name }, 'event consumer step failed');
        }
      }
      if (failures.includes('workflow-triggers') || failures.includes('wait-for-event'))
        throw new Error(`event ${event.id} failed: ${failures.join(', ')}`);
    });
  }

  private async index(event: DomainEvent): Promise<void> {
    const entity = event.entity as TriggerEntity;
    if (!INDEXED.has(entity)) return;
    if (event.type.startsWith('email.') || event.type.startsWith('note.') || event.type.startsWith('comment.')) return;
    await this.search.index(entity, event.entityId);
  }

  private async recordActivity(event: DomainEvent): Promise<void> {
    if (NO_ACTIVITY.has(event.type)) return;
    const workflowId = event.actor.type === 'workflow' ? (event.causation.at(-1)?.workflowId ?? null) : null;
    const data: Record<string, unknown> = { ...event.payload, ...(workflowId === null ? {} : { workflowId }) };
    const base = {
      kind: event.type,
      data,
      sourceKey: `${event.id}`,
      actorType: event.actor.type,
      actorId: event.actor.id,
      createdAt: new Date(event.occurredAt),
    };
    if (event.type === 'task.created' || event.type === 'task.completed') {
      const p = event.payload as { relatedType?: string | null; relatedId?: string | null };
      if (p.relatedType && p.relatedId) {
        await this.deps.db.scoped.$transaction((tx) =>
          this.activity.record(tx, { ...base, subjectType: p.relatedType as string, subjectId: p.relatedId as string }),
        );
      }
      return;
    }
    if (event.type === 'payment.created') return;
    if (!INDEXED.has(event.entity as TriggerEntity)) return;
    if (event.type.endsWith('.updated') && (event.payload as { reorder?: boolean }).reorder === true) return;
    await this.deps.db.scoped.$transaction(async (tx) => {
      await this.activity.record(tx, { ...base, subjectType: event.entity, subjectId: event.entityId });
      if (event.type === 'email.sent') {
        if (event.entity === 'contact')
          await tx.contact.updateMany({ where: { id: event.entityId }, data: { lastContactedAt: new Date() } });
        if (event.entity === 'deal')
          await tx.deal.updateMany({ where: { id: event.entityId }, data: { lastActivityAt: new Date() } });
      }
      if (event.type === 'invoice.created' || event.type === 'invoice.paid' || event.type === 'invoice.sent') {
        const inv = await tx.invoice.findFirst({
          where: { id: event.entityId },
          select: { companyId: true, dealId: true },
        });
        if (inv !== null)
          await this.activity.record(tx, {
            ...base,
            sourceKey: `${event.id}:company`,
            subjectType: 'company',
            subjectId: inv.companyId,
          });
        if (inv?.dealId)
          await this.activity.record(tx, {
            ...base,
            sourceKey: `${event.id}:deal`,
            subjectType: 'deal',
            subjectId: inv.dealId,
          });
      }
    });
  }

  private async notify(event: DomainEvent): Promise<void> {
    if (event.type === 'comment.created') {
      const p = event.payload as { mentions?: string[]; excerpt?: string; commentId?: string };
      const targets = (p.mentions ?? []).filter((id) => id !== event.actor.id);
      if (targets.length > 0) {
        await this.notifications.notify(
          targets,
          'mention',
          { subjectType: event.entity, subjectId: event.entityId, excerpt: p.excerpt ?? '', by: event.actor.id },
          `mention:${p.commentId ?? event.id}`,
        );
      }
    }
    if (event.type === 'task.created') {
      const p = event.payload as { assigneeId?: string | null; title?: string };
      if (p.assigneeId && p.assigneeId !== event.actor.id) {
        await this.notifications.notify(
          [p.assigneeId],
          'task.assigned',
          { taskId: event.entityId, title: p.title ?? '', actorType: event.actor.type },
          `task-assigned:${event.entityId}`,
        );
      }
    }
    if (event.type === 'approval.requested') {
      const approval = await this.deps.db.scoped.approval.findFirst({ where: { id: event.entityId } });
      if (approval !== null && approval.status === 'pending' && approval.source === 'agent')
        await this.approvals.afterCreate(approval);
    }
  }

  private async realtime(event: DomainEvent): Promise<void> {
    if (event.entity === 'deal') {
      await this.deps.realtime.publish(channels.deals(event.tenantId), {
        type: event.type,
        dealId: event.entityId,
        payload: event.payload,
        actor: event.actor,
      });
    }
    if (INDEXED.has(event.entity as TriggerEntity)) {
      await this.deps.realtime.publish(channels.record(event.tenantId, event.entity, event.entityId), {
        type: 'record.updated',
        event: event.type,
        entity: event.entity,
        id: event.entityId,
        actor: event.actor,
      });
    }
  }
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private current: Promise<number> | null = null;

  constructor(private readonly deps: CoreDeps) {}

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      let moved = 0;
      try {
        this.current = this.relayOnce();
        moved = await this.current;
      } catch (error) {
        this.deps.logger.error({ err: error }, 'outbox relay failed');
      }
      if (!this.stopped)
        this.timer = setTimeout(() => void tick(), moved >= 200 ? 0 : this.deps.config.engine.outboxPollMs);
    };
    void tick();
  }

  async relayOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.deps.db.system.outbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { id: true, createdAt: true },
      });
      if (rows.length === 0) return 0;
      for (const r of rows) {
        await this.deps.queues.enqueueEvent(r.id);
        this.deps.metrics.outboxLag.observe((Date.now() - r.createdAt.getTime()) / 1000);
      }
      await this.deps.db.system.outbox.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { publishedAt: new Date() },
      });
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.current !== null) await this.current.catch(() => 0);
  }
}
