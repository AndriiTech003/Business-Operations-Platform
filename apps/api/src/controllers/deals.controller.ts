import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  dealCreateSchema,
  dealMoveSchema,
  dealUpdateSchema,
  listQuerySchema,
  pipelineCreateSchema,
  type ListQuery,
} from '@bop/contracts';
import type { Core } from '@bop/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CORE, ZBody, ZQuery, etag, ifMatch, withIdempotency } from '../common/http';

const timelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

@Controller()
export class DealsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/pipelines')
  pipelines() {
    return this.core.deals.pipelines();
  }

  @Post('/v1/pipelines')
  createPipeline(@ZBody(pipelineCreateSchema) body: z.infer<typeof pipelineCreateSchema>) {
    return this.core.deals.createPipeline(body);
  }

  @Put('/v1/pipelines/:id')
  updatePipeline(@Param('id') id: string, @ZBody(pipelineCreateSchema) body: z.infer<typeof pipelineCreateSchema>) {
    return this.core.deals.updatePipeline(id, body);
  }

  @Get('/v1/deals')
  list(@ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.deals.list(q);
  }

  @Get('/v1/deals/board')
  board(@Query('pipelineId') pipelineId?: string) {
    return this.core.deals.board(pipelineId === undefined || pipelineId === '' ? undefined : pipelineId);
  }

  @Get('/v1/deals/forecast')
  forecast(@Query('pipelineId') pipelineId?: string) {
    return this.core.deals.forecast(pipelineId === undefined || pipelineId === '' ? undefined : pipelineId);
  }

  @Post('/v1/deals')
  create(@ZBody(dealCreateSchema) body: z.infer<typeof dealCreateSchema>) {
    return this.core.deals.create(body);
  }

  @Get('/v1/deals/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.core.deals.get(id);
    etag(res, dto.version);
    return dto;
  }

  @Patch('/v1/deals/:id')
  async update(
    @Param('id') id: string,
    @ZBody(dealUpdateSchema) body: z.infer<typeof dealUpdateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withIdempotency(this.core, req, res, `deal.update:${id}`, body, async () => {
      const dto = await this.core.deals.update(id, body, ifMatch(req));
      etag(res, dto.version);
      return dto;
    });
  }

  @Patch('/v1/deals/:id/move')
  async move(
    @Param('id') id: string,
    @ZBody(dealMoveSchema) body: z.infer<typeof dealMoveSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withIdempotency(this.core, req, res, `deal.move:${id}`, body, async () => {
      const dto = await this.core.deals.move(id, body, ifMatch(req));
      etag(res, dto.version);
      return dto;
    });
  }

  @Delete('/v1/deals/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.deals.remove(id);
  }

  @Get('/v1/deals/:id/timeline')
  timeline(@Param('id') id: string, @ZQuery(timelineQuery) q: z.infer<typeof timelineQuery>) {
    return this.core.activity.timeline('deal', id, q.limit, q.cursor);
  }
}
