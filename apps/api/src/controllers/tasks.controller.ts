import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  bulkCompleteSchema,
  commentCreateSchema,
  listQuerySchema,
  noteCreateSchema,
  subjectTypeSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type ListQuery,
} from '@bop/contracts';
import { badRequest, type Core } from '@bop/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CORE, ZBody, ZQuery, isDryRun, parse, principal, withIdempotency, type AuthedRequest } from '../common/http';

const timelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
const subjectQuery = z.object({ subjectType: subjectTypeSchema, subjectId: z.uuid() });
const readSchema = z.union([z.object({ ids: z.array(z.uuid()).min(1).max(500) }), z.object({ all: z.literal(true) })]);
const auditQuery = z.object({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

@Controller()
export class TasksController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/tasks')
  list(@ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.tasks.list(q);
  }

  @Get('/v1/tasks/my')
  my(@Req() req: AuthedRequest, @ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.tasks.my(principal(req).userId, q);
  }

  @Post('/v1/tasks')
  create(
    @ZBody(taskCreateSchema) body: z.infer<typeof taskCreateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isDryRun(req)) {
      res.status(200);
      return this.core.tasks.assertRelated(body.relatedType, body.relatedId).then(() => ({ dryRun: true, task: body }));
    }
    return withIdempotency(this.core, req, res, 'task.create', body, () => this.core.tasks.create(body), 201);
  }

  @Post('/v1/tasks/bulk-complete')
  @HttpCode(200)
  bulk(@ZBody(bulkCompleteSchema) body: z.infer<typeof bulkCompleteSchema>) {
    return this.core.tasks.bulkComplete(body.ids);
  }

  @Get('/v1/tasks/:id')
  get(@Param('id') id: string) {
    return this.core.tasks.get(id);
  }

  @Patch('/v1/tasks/:id')
  update(@Param('id') id: string, @ZBody(taskUpdateSchema) body: z.infer<typeof taskUpdateSchema>) {
    return this.core.tasks.update(id, body);
  }

  @Delete('/v1/tasks/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.tasks.remove(id);
  }

  @Get('/v1/records/:type/:id/timeline')
  timeline(
    @Param('type') type: string,
    @Param('id') id: string,
    @ZQuery(timelineQuery) q: z.infer<typeof timelineQuery>,
  ) {
    return this.core.activity.timeline(parse(subjectTypeSchema, type), id, q.limit, q.cursor);
  }

  @Get('/v1/records/:type/:id/tasks')
  recordTasks(@Param('type') type: string, @Param('id') id: string) {
    return this.core.tasks.forRecord(parse(subjectTypeSchema, type), id);
  }

  @Get('/v1/records/:type/:id/emails')
  recordEmails(@Param('type') type: string, @Param('id') id: string) {
    return this.core.emails.listFor(parse(subjectTypeSchema, type), id);
  }

  @Get('/v1/comments')
  comments(@ZQuery(subjectQuery) q: z.infer<typeof subjectQuery>) {
    return this.core.activity.comments(q.subjectType, q.subjectId);
  }

  @Post('/v1/comments')
  comment(@ZBody(commentCreateSchema) body: z.infer<typeof commentCreateSchema>) {
    return this.core.activity.addComment(body);
  }

  @Post('/v1/notes')
  note(
    @ZBody(noteCreateSchema) body: z.infer<typeof noteCreateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isDryRun(req)) {
      res.status(200);
      return { dryRun: true, note: body };
    }
    return withIdempotency(this.core, req, res, 'note.create', body, () => this.core.activity.addNote(body), 201);
  }

  @Get('/v1/notifications')
  notifications(@Req() req: AuthedRequest, @Query('unread') unread?: string) {
    return this.core.notifications.list(principal(req).userId, unread === '1' || unread === 'true');
  }

  @Post('/v1/notifications/read')
  @HttpCode(200)
  async read(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const body = parse(readSchema, raw);
    const count = await this.core.notifications.markRead(principal(req).userId, 'all' in body ? 'all' : body.ids);
    return { updated: count };
  }

  @Get('/v1/audit')
  audit(@ZQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    if (q.entityId !== undefined && q.entity === undefined) throw badRequest('entity is required with entityId');
    return this.core.activity.audit(q.entity, q.entityId, q.limit, q.cursor);
  }
}
