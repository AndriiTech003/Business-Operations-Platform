import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  approvalCreateSchema,
  approvalDecideSchema,
  draftSaveSchema,
  manualRunSchema,
  testRunSchema,
  workflowCreateSchema,
  workflowUpdateSchema,
  type WorkflowDefinition,
} from '@bop/contracts';
import { notFound, type Core } from '@bop/core';
import { z } from 'zod';
import { CORE, ZBody, ZQuery, principal, type AuthedRequest } from '../common/http';

const runsQuery = z.object({
  workflowId: z.uuid().optional(),
  status: z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']).optional(),
  includeTests: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

@Controller()
export class ApprovalsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/approvals')
  list(@Req() req: AuthedRequest, @Query('status') status?: string, @Query('mine') mine?: string) {
    return this.core.approvals.list(
      status === undefined || status === '' || status === 'all' ? undefined : status,
      mine === '1' || mine === 'true' ? principal(req).userId : undefined,
    );
  }

  @Get('/v1/approvals/count')
  async count(@Req() req: AuthedRequest) {
    return { count: await this.core.approvals.pendingCount(principal(req).userId) };
  }

  @Post('/v1/approvals')
  create(@ZBody(approvalCreateSchema) body: z.infer<typeof approvalCreateSchema>) {
    return this.core.approvals.createExternal(body);
  }

  @Get('/v1/approvals/:id')
  get(@Param('id') id: string) {
    return this.core.approvals.get(id);
  }

  @Post('/v1/approvals/:id/decide')
  @HttpCode(200)
  decide(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @ZBody(approvalDecideSchema) body: z.infer<typeof approvalDecideSchema>,
  ) {
    const p = principal(req);
    return this.core.approvals.decide(id, body, p.userId, p.role);
  }
}

@Controller()
export class WorkflowsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/v1/workflows')
  list() {
    return this.core.workflows.list();
  }

  @Post('/v1/workflows')
  create(@ZBody(workflowCreateSchema) body: z.infer<typeof workflowCreateSchema>) {
    return this.core.workflows.create(body);
  }

  @Get('/v1/workflows/templates')
  templates() {
    return this.core.workflows.templates();
  }

  @Post('/v1/workflows/validate')
  @HttpCode(200)
  validate(@Body() body: { definition?: unknown }) {
    return this.core.workflows.validate(body?.definition);
  }

  @Get('/v1/workflows/:id')
  get(@Param('id') id: string) {
    return this.core.workflows.get(id);
  }

  @Patch('/v1/workflows/:id')
  update(@Param('id') id: string, @ZBody(workflowUpdateSchema) body: z.infer<typeof workflowUpdateSchema>) {
    return this.core.workflows.update(id, body);
  }

  @Delete('/v1/workflows/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.workflows.remove(id);
  }

  @Put('/v1/workflows/:id/draft')
  saveDraft(@Param('id') id: string, @ZBody(draftSaveSchema) body: z.infer<typeof draftSaveSchema>) {
    return this.core.workflows.saveDraft(id, body.definition);
  }

  @Get('/v1/workflows/:id/diff')
  diff(@Param('id') id: string) {
    return this.core.workflows.diff(id);
  }

  @Post('/v1/workflows/:id/publish')
  @HttpCode(200)
  publish(@Param('id') id: string) {
    return this.core.workflows.publish(id);
  }

  @Get('/v1/workflows/:id/versions/:version')
  async version(
    @Param('id') id: string,
    @Param('version') version: string,
  ): Promise<{ version: number; definition: WorkflowDefinition }> {
    await this.core.workflows.row(id);
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw notFound('Version');
    const loaded = await this.core.workflows.loadVersion(id, n);
    return { version: n, definition: loaded.definition };
  }

  @Post('/v1/workflows/:id/runs')
  manual(@Param('id') id: string, @ZBody(manualRunSchema) body: z.infer<typeof manualRunSchema>) {
    return this.core.runs.manualRun(id, body);
  }

  @Post('/v1/workflows/:id/test-runs')
  test(@Param('id') id: string, @ZBody(testRunSchema) body: z.infer<typeof testRunSchema>) {
    return this.core.runs.testRun(id, body);
  }

  @Get('/v1/workflow-runs')
  runs(@ZQuery(runsQuery) q: z.infer<typeof runsQuery>) {
    return this.core.runs.list({ ...q, includeTests: q.includeTests === '1' || q.includeTests === 'true' });
  }

  @Get('/v1/workflow-runs/:id')
  run(@Param('id') id: string) {
    return this.core.runs.get(id);
  }

  @Post('/v1/workflow-runs/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    await this.core.engine.cancelRun(id);
    return this.core.runs.get(id);
  }

  @Post('/v1/workflow-runs/:id/steps/:stepId/retry')
  @HttpCode(200)
  async retry(@Param('id') id: string, @Param('stepId') stepId: string) {
    await this.core.engine.retryStep(id, stepId);
    return this.core.runs.get(id);
  }

  @Post('/hooks/:workflowId/:secret')
  @HttpCode(202)
  hook(@Param('workflowId') workflowId: string, @Param('secret') secret: string, @Body() body: unknown) {
    return this.core.runs.webhook(workflowId, secret, body ?? {});
  }
}
