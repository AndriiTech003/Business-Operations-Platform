import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import {
  companyCreateSchema,
  companyUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  importCreateSchema,
  listQuerySchema,
  mergeSchema,
  type ImportCreate,
  type ListQuery,
} from '@bop/contracts';
import type { Core } from '@bop/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CORE, ZBody, ZQuery, etag, ifMatch } from '../common/http';

const timelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

@Controller()
export class CompaniesController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/companies')
  list(@ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.companies.list(q);
  }

  @Post('/v1/companies')
  create(@ZBody(companyCreateSchema) body: z.infer<typeof companyCreateSchema>) {
    return this.core.companies.create(body);
  }

  @Get('/v1/companies/duplicates')
  duplicates() {
    return this.core.companies.findDuplicates();
  }

  @Post('/v1/companies/merge')
  @HttpCode(200)
  merge(@ZBody(mergeSchema) body: z.infer<typeof mergeSchema>) {
    return this.core.companies.merge(body);
  }

  @Post('/v1/companies/import')
  @HttpCode(202)
  import(@ZBody(importCreateSchema) body: ImportCreate) {
    return this.core.imports.create({ ...body, entity: 'company' });
  }

  @Get('/v1/companies/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.core.companies.get(id);
    etag(res, dto.version);
    return dto;
  }

  @Patch('/v1/companies/:id')
  async update(
    @Param('id') id: string,
    @ZBody(companyUpdateSchema) body: z.infer<typeof companyUpdateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await this.core.companies.update(id, body, ifMatch(req));
    etag(res, dto.version);
    return dto;
  }

  @Delete('/v1/companies/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.companies.remove(id);
  }

  @Get('/v1/companies/:id/timeline')
  timeline(@Param('id') id: string, @ZQuery(timelineQuery) q: z.infer<typeof timelineQuery>) {
    return this.core.activity.timeline('company', id, q.limit, q.cursor);
  }
}

@Controller()
export class ContactsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/contacts')
  list(@ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.contacts.list(q);
  }

  @Post('/v1/contacts')
  create(@ZBody(contactCreateSchema) body: z.infer<typeof contactCreateSchema>) {
    return this.core.contacts.create(body);
  }

  @Get('/v1/contacts/duplicates')
  duplicates() {
    return this.core.contacts.findDuplicates();
  }

  @Post('/v1/contacts/merge')
  @HttpCode(200)
  merge(@ZBody(mergeSchema) body: z.infer<typeof mergeSchema>) {
    return this.core.contacts.merge(body);
  }

  @Post('/v1/contacts/import')
  @HttpCode(202)
  import(@ZBody(importCreateSchema) body: ImportCreate) {
    return this.core.imports.create({ ...body, entity: 'contact' });
  }

  @Get('/v1/contacts/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.core.contacts.get(id);
    etag(res, dto.version);
    return dto;
  }

  @Patch('/v1/contacts/:id')
  async update(
    @Param('id') id: string,
    @ZBody(contactUpdateSchema) body: z.infer<typeof contactUpdateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await this.core.contacts.update(id, body, ifMatch(req));
    etag(res, dto.version);
    return dto;
  }

  @Delete('/v1/contacts/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.contacts.remove(id);
  }

  @Get('/v1/contacts/:id/timeline')
  timeline(@Param('id') id: string, @ZQuery(timelineQuery) q: z.infer<typeof timelineQuery>) {
    return this.core.activity.timeline('contact', id, q.limit, q.cursor);
  }

  @Get('/v1/imports')
  imports() {
    return this.core.imports.list();
  }

  @Get('/v1/imports/:id')
  importJob(@Param('id') id: string) {
    return this.core.imports.get(id);
  }
}
