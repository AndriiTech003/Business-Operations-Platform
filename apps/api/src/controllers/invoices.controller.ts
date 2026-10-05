import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import {
  invoiceCreateSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
  listQuerySchema,
  paymentCreateSchema,
  type ListQuery,
} from '@bop/contracts';
import { DomainError, QUEUE_NAMES, createRedis, notFound, requireTenantId, runInContext, type Core } from '@bop/core';
import { QueueEvents } from 'bullmq';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CORE, ZBody, ZQuery, etag, idempotencyKey, ifMatch, isDryRun, parse } from '../common/http';

const timelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
const voidSchema = z.object({ reason: z.string().max(500).optional() });

@Controller()
export class InvoicesController {
  private events: QueueEvents | null = null;

  constructor(@Inject(CORE) private readonly core: Core) {}

  private async idempotent<T>(
    req: Request,
    res: Response,
    scope: string,
    body: unknown,
    fn: () => Promise<T>,
    status = 200,
  ): Promise<unknown> {
    const key = idempotencyKey(req);
    if (key === null) {
      res.status(status);
      return fn();
    }
    const out = await this.core.idempotency.run(scope, key, body, async () => ({ status, body: await fn() }));
    res.status(out.status);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  }

  private async pdfBytes(invoiceId: string): Promise<Buffer> {
    const cached = await this.core.documents.cachedPdf(invoiceId);
    if (cached !== null) return cached;
    this.events ??= new QueueEvents(QUEUE_NAMES.pdf, {
      connection: createRedis(this.core.config.redisUrl, true),
      prefix: `${this.core.config.redisPrefix}:bull`,
    });
    await this.events.waitUntilReady();
    const job = await this.core.deps.queues.pdf.add(
      'render',
      { invoiceId, tenantId: requireTenantId() },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    try {
      await job.waitUntilFinished(this.events, 45_000);
    } catch (error) {
      throw new DomainError(
        503,
        'pdf_unavailable',
        `PDF rendering failed or no worker is running: ${(error as Error).message}`,
      );
    }
    const bytes = await this.core.documents.cachedPdf(invoiceId);
    if (bytes === null) throw new DomainError(503, 'pdf_unavailable', 'PDF is not available yet');
    return bytes;
  }

  @Get('/v1/invoices')
  list(@ZQuery(listQuerySchema) q: ListQuery) {
    return this.core.invoices.list(q);
  }

  @Post('/v1/invoices')
  create(
    @ZBody(invoiceCreateSchema) body: z.infer<typeof invoiceCreateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotent(req, res, 'invoice.create', body, () => this.core.invoices.create(body), 201);
  }

  @Get('/v1/invoices/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.core.invoices.get(id);
    etag(res, dto.version);
    return dto;
  }

  @Patch('/v1/invoices/:id')
  async update(
    @Param('id') id: string,
    @ZBody(invoiceUpdateSchema) body: z.infer<typeof invoiceUpdateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await this.core.invoices.update(id, body, ifMatch(req));
    etag(res, dto.version);
    return dto;
  }

  @Delete('/v1/invoices/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.core.invoices.remove(id);
  }

  @Post('/v1/invoices/:id/send')
  async send(
    @Param('id') id: string,
    @ZBody(invoiceSendSchema) body: z.infer<typeof invoiceSendSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isDryRun(req)) {
      const invoice = await this.core.invoices.get(id);
      const rendered = await this.core.emails.renderTemplate('invoice_sent', { entity: 'invoice', id });
      const to = body.to ?? (invoice.contact?.email ? [invoice.contact.email] : []);
      res.status(200);
      return {
        dryRun: true,
        invoice,
        email: {
          to,
          subject: body.subject ?? rendered.subject,
          html: rendered.html,
          attachment: `${invoice.number}.pdf`,
        },
        change: { status: { from: invoice.status, to: invoice.status === 'draft' ? 'sent' : invoice.status } },
      };
    }
    return this.idempotent(req, res, `invoice.send:${id}`, body, () => this.core.invoices.send(id, body));
  }

  @Post('/v1/invoices/:id/payments')
  payment(
    @Param('id') id: string,
    @ZBody(paymentCreateSchema) body: z.infer<typeof paymentCreateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotent(req, res, `invoice.payment:${id}`, body, () => this.core.invoices.addPayment(id, body), 201);
  }

  @Post('/v1/invoices/:id/void')
  @HttpCode(200)
  async void(
    @Param('id') id: string,
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parse(voidSchema, raw);
    if (isDryRun(req)) return { dryRun: true, ...(await this.core.invoices.previewVoid(id)) };
    return this.idempotent(req, res, `invoice.void:${id}`, body, () => this.core.invoices.void(id, body.reason));
  }

  @Get('/v1/invoices/:id/pdf')
  async pdf(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const invoice = await this.core.invoices.get(id);
    const bytes = await this.pdfBytes(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${invoice.number}.pdf"`);
    res.end(bytes);
  }

  @Get('/v1/invoices/:id/preview')
  async preview(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const html = await this.core.documents.html(id);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.end(html);
  }

  @Get('/v1/invoices/:id/timeline')
  timeline(@Param('id') id: string, @ZQuery(timelineQuery) q: z.infer<typeof timelineQuery>) {
    return this.core.activity.timeline('invoice', id, q.limit, q.cursor);
  }

  @Get('/p/invoices/:token')
  async publicView(@Param('token') token: string) {
    const view = await this.core.invoices.publicView(token);
    if (view === null) throw notFound('Invoice');
    return view;
  }

  @Get('/p/invoices/:token/pdf')
  async publicPdf(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const found = await this.core.invoices.findByToken(token);
    if (found === null || found.invoice.status === 'draft') throw notFound('Invoice');
    const bytes = await runInContext(
      { tenantId: found.tenantId, actor: { type: 'system', id: null }, causation: [] },
      () => this.pdfBytes(found.invoice.id),
    );
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${found.invoice.number}.pdf"`);
    res.end(bytes);
  }

  @Post('/p/invoices/:token/pay')
  @HttpCode(200)
  async publicPay(@Param('token') token: string) {
    if (process.env['DEMO_PUBLIC_PAY'] === '0') throw new DomainError(403, 'disabled', 'Demo payments are disabled');
    const view = await this.core.invoices.publicPay(token);
    if (view === null) throw notFound('Invoice');
    return view;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.events !== null) await this.events.close();
  }
}
