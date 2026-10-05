import type {
  ActivityDto,
  AuditLogDto,
  CommentCreate,
  CommentDto,
  NoteCreate,
  NotificationDto,
  Page,
  SubjectType,
} from '@bop/contracts';
import { UNTRUSTED_ACTIVITY_FIELDS, isExternalCompany, isExternalSource } from '@bop/contracts';
import type { CoreDeps } from '../deps';
import { requireContext, requireTenantId } from '../context';
import { forbidden, notFound, validationFailed } from '../errors';
import { emitEvent } from '../events/outbox';
import type { Activity, Notification } from '../generated/prisma/client';
import type { Scoped } from '../db/tenancy';
import { decodeCursor, encodeCursor, isoRequired, iso } from '../util/json';
import type { Directory } from './directory';
import { isUniqueViolation } from '../errors';

const MENTION = /@\[([^\]]{1,100})\]\(([0-9a-f-]{36})\)/g;

export function extractMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION)) if (m[2] !== undefined) ids.add(m[2]);
  return [...ids];
}

export async function subjectExists(db: Scoped, type: SubjectType, id: string): Promise<boolean> {
  switch (type) {
    case 'company':
      return (await db.company.count({ where: { id } })) > 0;
    case 'contact':
      return (await db.contact.count({ where: { id } })) > 0;
    case 'deal':
      return (await db.deal.count({ where: { id } })) > 0;
    case 'invoice':
      return (await db.invoice.count({ where: { id } })) > 0;
    case 'task':
      return (await db.task.count({ where: { id } })) > 0;
  }
}

export class ActivityService {
  constructor(
    private readonly deps: CoreDeps,
    private readonly directory: Directory,
  ) {}

  async toDtos(rows: Activity[]): Promise<ActivityDto[]> {
    const users = await this.directory.usersById(rows.filter((r) => r.actorType === 'user').map((r) => r.actorId));
    const workflowIds = [
      ...new Set(
        rows
          .filter((r) => r.actorType === 'workflow')
          .map((r) => (r.data as { workflowId?: string }).workflowId)
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    const workflows =
      workflowIds.length === 0
        ? []
        : await this.deps.db.scoped.workflow.findMany({
            where: { id: { in: workflowIds } },
            select: { id: true, name: true },
          });
    const wfNames = new Map(workflows.map((w) => [w.id, w.name]));
    return rows.map((a) => {
      const data = (a.data ?? {}) as Record<string, unknown>;
      let actorName: string | null;
      if (a.actorType === 'user' && a.actorId !== null) actorName = users.get(a.actorId)?.name ?? null;
      else if (a.actorType === 'workflow')
        actorName = `Workflow: ${wfNames.get(String(data['workflowId'] ?? '')) ?? 'workflow'}`;
      else if (a.actorType === 'agent') actorName = 'AI agent';
      else actorName = 'System';
      const dto: ActivityDto = {
        id: a.id,
        subjectType: a.subjectType as SubjectType,
        subjectId: a.subjectId,
        kind: a.kind,
        actorType: a.actorType as ActivityDto['actorType'],
        actorId: a.actorId,
        actorName,
        data,
        createdAt: isoRequired(a.createdAt),
      };
      if (data['external'] === true)
        dto.untrusted = UNTRUSTED_ACTIVITY_FIELDS.filter((p) => data[p.slice(5)] !== undefined);
      return dto;
    });
  }

  private async subjectIsExternal(subjectType: SubjectType, subjectId: string): Promise<boolean> {
    if (subjectType === 'contact') {
      const c = await this.deps.db.scoped.contact.findFirst({ where: { id: subjectId }, select: { source: true } });
      return c !== null && isExternalSource(c.source);
    }
    if (subjectType === 'company') {
      const c = await this.deps.db.scoped.company.findFirst({
        where: { id: subjectId },
        select: { source: true, tags: true },
      });
      return c !== null && isExternalCompany(c);
    }
    return false;
  }

  async timeline(subjectType: SubjectType, subjectId: string, limit = 50, cursor?: string): Promise<Page<ActivityDto>> {
    const c = decodeCursor(cursor);
    const rows = await this.deps.db.scoped.activity.findMany({
      where: {
        subjectType,
        subjectId,
        ...(c === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: new Date(String(c.v)) } },
                { createdAt: new Date(String(c.v)), id: { lt: c.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const dtos = await this.toDtos(items);
    if (await this.subjectIsExternal(subjectType, subjectId)) {
      for (const dto of dtos) {
        if (!dto.kind.startsWith(`${subjectType}.`)) continue;
        const extra = ['data.changes', 'data.name', 'data.merged'].filter((p) => dto.data[p.slice(5)] !== undefined);
        if (extra.length > 0) dto.untrusted = [...new Set([...(dto.untrusted ?? []), ...extra])];
      }
    }
    return {
      items: dtos,
      nextCursor: hasMore && last !== undefined ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async record(
    tx: Scoped,
    input: {
      subjectType: string;
      subjectId: string;
      kind: string;
      data: Record<string, unknown>;
      sourceKey?: string | null;
      actorType?: string;
      actorId?: string | null;
      createdAt?: Date;
    },
  ): Promise<void> {
    const ctx = requireContext();
    try {
      await tx.activity.create({
        data: {
          tenantId: ctx.tenantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          actorType: input.actorType ?? ctx.actor.type,
          actorId: input.actorId === undefined ? ctx.actor.id : input.actorId,
          data: input.data as never,
          sourceKey: input.sourceKey ?? null,
          createdAt: input.createdAt,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async addNote(input: NoteCreate): Promise<ActivityDto> {
    const ctx = requireContext();
    if (!(await subjectExists(this.deps.db.scoped, input.subjectType, input.subjectId)))
      throw notFound(input.subjectType);
    const created = await this.deps.db.scoped.$transaction(async (tx) => {
      const a = await tx.activity.create({
        data: {
          tenantId: ctx.tenantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          data: {
            body: input.body,
            ...(input.external === true ? { external: true } : {}),
            ...(ctx.actor.type === 'workflow' ? { workflowId: ctx.causation.at(-1)?.workflowId } : {}),
          } as never,
        },
      });
      if (input.kind !== 'note' && input.subjectType === 'contact')
        await tx.contact.updateMany({ where: { id: input.subjectId }, data: { lastContactedAt: new Date() } });
      if (input.subjectType === 'deal')
        await tx.deal.updateMany({ where: { id: input.subjectId }, data: { lastActivityAt: new Date() } });
      await emitEvent(tx, {
        type: 'note.added',
        entity: input.subjectType,
        entityId: input.subjectId,
        payload: { activityId: a.id, kind: input.kind },
      });
      return a;
    });
    return (await this.toDtos([created]))[0] as ActivityDto;
  }

  async comments(subjectType: SubjectType, subjectId: string): Promise<CommentDto[]> {
    const rows = await this.deps.db.scoped.comment.findMany({
      where: { subjectType, subjectId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const users = await this.directory.usersById(rows.map((r) => r.authorId));
    return rows.map((c) => ({
      id: c.id,
      subjectType: c.subjectType as SubjectType,
      subjectId: c.subjectId,
      authorId: c.authorId,
      author: users.get(c.authorId) ?? null,
      body: c.body,
      mentions: c.mentions,
      createdAt: isoRequired(c.createdAt),
    }));
  }

  async addComment(input: CommentCreate): Promise<CommentDto> {
    const ctx = requireContext();
    if (ctx.actor.type !== 'user' || ctx.actor.id === null) throw forbidden('Only users can comment');
    if (!(await subjectExists(this.deps.db.scoped, input.subjectType, input.subjectId)))
      throw notFound(input.subjectType);
    const mentioned = extractMentions(input.body);
    const members = await this.directory.usersById(mentioned);
    const unknown = mentioned.filter((id) => !members.has(id));
    if (unknown.length > 0)
      throw validationFailed(
        'Mentioned users are not members',
        unknown.map((id) => ({ path: 'body', message: `unknown user ${id}` })),
      );
    const comment = await this.deps.db.scoped.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: {
          tenantId: ctx.tenantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          authorId: ctx.actor.id as string,
          body: input.body,
          mentions: mentioned,
        },
      });
      await emitEvent(tx, {
        type: 'comment.created',
        entity: input.subjectType,
        entityId: input.subjectId,
        payload: { commentId: c.id, mentions: mentioned, excerpt: input.body.replace(MENTION, '@$1').slice(0, 200) },
      });
      return c;
    });
    return (await this.comments(input.subjectType, input.subjectId)).find((c) => c.id === comment.id) as CommentDto;
  }

  async audit(
    entity: string | undefined,
    entityId: string | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<AuditLogDto>> {
    const c = decodeCursor(cursor);
    const rows = await this.deps.db.scoped.auditLog.findMany({
      where: {
        ...(entity === undefined ? {} : { entity }),
        ...(entityId === undefined ? {} : { entityId }),
        ...(c === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: new Date(String(c.v)) } },
                { createdAt: new Date(String(c.v)), id: { lt: c.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const users = await this.directory.usersById(items.map((r) => r.actorId));
    const last = items[items.length - 1];
    return {
      items: items.map((a) => ({
        id: a.id,
        actorType: a.actorType as AuditLogDto['actorType'],
        actorId: a.actorId,
        actorName: a.actorId === null ? null : (users.get(a.actorId)?.name ?? null),
        action: a.action,
        entity: a.entity,
        entityId: a.entityId,
        diff: (a.diff ?? {}) as Record<string, unknown>,
        createdAt: isoRequired(a.createdAt),
      })),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }
}

export function notificationDto(n: Notification): NotificationDto {
  return {
    id: n.id,
    kind: n.kind,
    payload: (n.payload ?? {}) as Record<string, unknown>,
    readAt: iso(n.readAt),
    createdAt: isoRequired(n.createdAt),
  };
}

export class NotificationsService {
  constructor(private readonly deps: CoreDeps) {}

  async notify(
    userIds: string[],
    kind: string,
    payload: Record<string, unknown>,
    sourceKey: string | null,
  ): Promise<string[]> {
    const tenantId = requireTenantId();
    const created: Notification[] = [];
    for (const userId of [...new Set(userIds)]) {
      try {
        const n = await this.deps.db.scoped.notification.create({
          data: {
            tenantId,
            userId,
            kind,
            payload: payload as never,
            sourceKey: sourceKey === null ? null : `${sourceKey}:${userId}`,
          },
        });
        created.push(n);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    for (const n of created)
      await this.deps.realtime.toUser(n.userId, { type: 'notification', notification: notificationDto(n) });
    return created.map((n) => n.userId);
  }

  async list(userId: string, unreadOnly: boolean, limit = 50): Promise<{ items: NotificationDto[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.deps.db.scoped.notification.findMany({
        where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.deps.db.scoped.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items: rows.map(notificationDto), unread };
  }

  async markRead(userId: string, ids: string[] | 'all'): Promise<number> {
    const res = await this.deps.db.scoped.notification.updateMany({
      where: { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return res.count;
  }
}
