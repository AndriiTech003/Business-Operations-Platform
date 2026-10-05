import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  CUSTOM_FIELD_ENTITIES,
  ENTITY_TYPES,
  apiTokenCreateSchema,
  customFieldCreateSchema,
  customFieldReorderSchema,
  customFieldUpdateSchema,
  emailDraftSchema,
  emailTemplateUpsertSchema,
  reportQuerySchema,
  secretUpsertSchema,
  type SubjectType,
} from '@bop/contracts';
import { badRequest, type Core } from '@bop/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  CORE,
  ZBody,
  ZQuery,
  idempotencyKey,
  isDryRun,
  parse,
  principal,
  withIdempotency,
  type AuthedRequest,
} from '../common/http';

const previewSchema = z.object({
  subject: z.string().max(500),
  body: z.string().max(50000),
  entity: z.enum(['company', 'contact', 'deal', 'invoice', 'task']).optional(),
  id: z.uuid().optional(),
});

@Controller()
export class AdminController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/custom-fields')
  customFields(@Query('entity') entity?: string) {
    if (entity !== undefined && !(CUSTOM_FIELD_ENTITIES as readonly string[]).includes(entity))
      throw badRequest('Unknown entity');
    return this.core.customFields.list(entity as (typeof CUSTOM_FIELD_ENTITIES)[number] | undefined);
  }

  @Post('/v1/custom-fields')
  createField(@ZBody(customFieldCreateSchema) body: z.infer<typeof customFieldCreateSchema>) {
    return this.core.customFields.create(body);
  }

  @Post('/v1/custom-fields/reorder')
  @HttpCode(200)
  reorder(@ZBody(customFieldReorderSchema) body: z.infer<typeof customFieldReorderSchema>) {
    return this.core.customFields.reorder(body.ids);
  }

  @Patch('/v1/custom-fields/:id')
  updateField(@Param('id') id: string, @ZBody(customFieldUpdateSchema) body: z.infer<typeof customFieldUpdateSchema>) {
    return this.core.customFields.update(id, body);
  }

  @Delete('/v1/custom-fields/:id')
  @HttpCode(204)
  async removeField(@Param('id') id: string): Promise<void> {
    await this.core.customFields.remove(id);
  }

  @Get('/v1/search')
  search(@Query('q') q?: string, @Query('types') types?: string, @Query('limit') limit?: string) {
    const list =
      types === undefined || types === ''
        ? null
        : types.split(',').filter((t): t is SubjectType => (ENTITY_TYPES as readonly string[]).includes(t));
    return this.core.search.search(q ?? '', list, Math.min(20, Math.max(1, Number(limit ?? 5) || 5)));
  }

  @Get('/v1/reports/pipeline')
  pipeline(@ZQuery(reportQuerySchema) q: z.infer<typeof reportQuerySchema>) {
    return this.core.reports.pipeline(q);
  }

  @Get('/v1/reports/revenue')
  revenue(@ZQuery(reportQuerySchema) q: z.infer<typeof reportQuerySchema>) {
    return this.core.reports.revenue(q);
  }

  @Get('/v1/reports/ar-aging')
  arAging() {
    return this.core.reports.arAging();
  }

  @Get('/v1/reports/activity')
  activity(@ZQuery(reportQuerySchema) q: z.infer<typeof reportQuerySchema>) {
    return this.core.reports.activity(q);
  }

  @Get('/v1/api-tokens')
  tokens() {
    return this.core.accounts.listApiTokens();
  }

  @Post('/v1/api-tokens')
  createToken(@Req() req: AuthedRequest, @ZBody(apiTokenCreateSchema) body: z.infer<typeof apiTokenCreateSchema>) {
    const p = principal(req);
    return this.core.accounts.createApiToken(p.userId, p.role, body);
  }

  @Delete('/v1/api-tokens/:id')
  @HttpCode(204)
  async revokeToken(@Param('id') id: string): Promise<void> {
    await this.core.accounts.revokeApiToken(id);
  }

  @Get('/v1/secrets')
  secrets() {
    return this.core.secrets.list();
  }

  @Put('/v1/secrets/:name')
  putSecret(@Req() req: AuthedRequest, @Param('name') name: string, @Body() raw: unknown) {
    const body = parse(secretUpsertSchema, { ...(raw as object), name });
    return this.core.secrets.upsert(
      body.name,
      body.value,
      principal(req).actor.type === 'user' ? principal(req).userId : null,
    );
  }

  @Delete('/v1/secrets/:name')
  @HttpCode(204)
  async removeSecret(@Param('name') name: string): Promise<void> {
    await this.core.secrets.remove(name);
  }

  @Get('/v1/email-templates')
  templates() {
    return this.core.emails.templates();
  }

  @Put('/v1/email-templates/:key')
  putTemplate(@Param('key') key: string, @Body() raw: unknown) {
    return this.core.emails.upsertTemplate(parse(emailTemplateUpsertSchema, { ...(raw as object), key }));
  }

  @Delete('/v1/email-templates/:key')
  @HttpCode(204)
  async removeTemplate(@Param('key') key: string): Promise<void> {
    await this.core.emails.removeTemplate(key);
  }

  @Post('/v1/email-templates/preview')
  @HttpCode(200)
  previewTemplate(@ZBody(previewSchema) body: z.infer<typeof previewSchema>) {
    return this.core.emails.preview(body);
  }

  @Post('/v1/emails/drafts')
  draft(
    @ZBody(emailDraftSchema) body: z.infer<typeof emailDraftSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isDryRun(req)) {
      res.status(200);
      return { dryRun: true, email: body };
    }
    return withIdempotency(this.core, req, res, 'email.draft', body, () => this.core.emails.createDraft(body), 201);
  }

  @Get('/v1/emails/:id')
  email(@Param('id') id: string) {
    return this.core.emails.getMessage(id);
  }

  @Post('/v1/emails/:id/send')
  async sendEmail(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (isDryRun(req)) {
      res.status(200);
      return { dryRun: true, email: await this.core.emails.getMessage(id) };
    }
    const key = idempotencyKey(req);
    if (key === null) {
      res.status(200);
      return this.core.emails.sendDraft(id);
    }
    const out = await this.core.idempotency.run(`email.send:${id}`, key, {}, async () => ({
      status: 200,
      body: await this.core.emails.sendDraft(id),
    }));
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status);
    return out.body;
  }
}
