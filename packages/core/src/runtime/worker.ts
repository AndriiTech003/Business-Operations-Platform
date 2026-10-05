import { createServer, type Server } from 'node:http';
import { Worker, type Job } from 'bullmq';
import { runInContext } from '../context';
import type { Core } from '../core';
import { MailDispatcher } from '../mail/dispatcher';
import { PdfRenderer } from '../pdf/renderer';
import { QUEUE_NAMES, createRedis } from '../queues';
import { signPayload } from '../util/webhook-signature';

export interface WorkerRuntimeOptions {
  metricsPort?: number;
  relay?: boolean;
  mail?: boolean;
}

export class WorkerRuntime {
  private readonly workers: Worker[] = [];
  private mail: MailDispatcher | null = null;
  private readonly renderer: PdfRenderer;
  private server: Server | null = null;

  constructor(
    private readonly core: Core,
    private readonly options: WorkerRuntimeOptions = {},
  ) {
    this.renderer = new PdfRenderer(core.logger);
  }

  async start(): Promise<void> {
    const { config, logger } = this.core.deps;
    await this.core.start();
    await this.core.engine.cancels.start();
    const prefix = `${config.redisPrefix}:bull`;
    const make = (name: string, concurrency: number, fn: (job: Job) => Promise<unknown>) => {
      const worker = new Worker(name, fn, {
        connection: createRedis(config.redisUrl, true),
        prefix,
        concurrency,
        lockDuration: 60_000,
        stalledInterval: 30_000,
      });
      worker.on('failed', (job, error) =>
        logger.warn({ queue: name, jobId: job?.id, err: error.message }, 'job failed'),
      );
      worker.on('error', (error) => logger.warn({ queue: name, err: error.message }, 'worker error'));
      this.workers.push(worker);
    };
    make(QUEUE_NAMES.steps, config.engine.stepConcurrency, (job) =>
      this.core.engine.processJob(job.data as { stepRunId: string; tenantId: string; kind?: string }),
    );
    make(QUEUE_NAMES.events, 8, (job) => this.core.consumer.handle((job.data as { outboxId: string }).outboxId));
    make(QUEUE_NAMES.imports, 1, (job) =>
      this.core.imports.runJob(job.data as Parameters<typeof this.core.imports.runJob>[0]),
    );
    make(QUEUE_NAMES.pdf, 2, (job) => {
      const data = job.data as { invoiceId: string; tenantId: string };
      return runInContext({ tenantId: data.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
        const pdf = await this.core.documents.ensurePdf(data.invoiceId, this.renderer);
        return { key: pdf.key, bytes: pdf.bytes.length };
      });
    });
    make(QUEUE_NAMES.callbacks, 4, (job) => this.deliverCallback(job.data as { approvalId: string; tenantId: string }));
    if (this.options.mail !== false) {
      this.mail = new MailDispatcher(this.core.deps, this.core.emails, this.core.documents, this.renderer);
      this.mail.start();
      make(QUEUE_NAMES.emails, 1, () => (this.mail as MailDispatcher).runOnce());
    }
    if (this.options.relay !== false) this.core.relay.start();
    if (this.options.metricsPort !== undefined) {
      this.server = createServer((req, res) => {
        if (req.url === '/metrics') {
          void this.core.deps.metrics.registry.metrics().then((body) => {
            res.writeHead(200, { 'content-type': this.core.deps.metrics.registry.contentType });
            res.end(body);
          });
          return;
        }
        res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', worker: config.engine.workerId }));
      });
      await new Promise<void>((resolve) => this.server?.listen(this.options.metricsPort, '127.0.0.1', resolve));
    }
    logger.info({ worker: config.engine.workerId, concurrency: config.engine.stepConcurrency }, 'worker started');
  }

  private async deliverCallback(data: { approvalId: string; tenantId: string }): Promise<unknown> {
    return runInContext({ tenantId: data.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
      const approval = await this.core.deps.db.scoped.approval.findFirst({ where: { id: data.approvalId } });
      if (approval === null || approval.callbackUrl === null) return 'skipped';
      const body = JSON.stringify({
        type: 'approval.decided',
        approvalId: approval.id,
        status: approval.status,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        comment: approval.comment,
        sourceRef: approval.sourceRef,
      });
      const res = await fetch(approval.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bop-signature': signPayload(body, this.core.config.jwtSecret),
          'idempotency-key': `approval-${approval.id}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`callback returned ${res.status}`);
      await this.core.deps.db.scoped.approval.update({ where: { id: approval.id }, data: { callbackAt: new Date() } });
      return 'delivered';
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    if (this.mail !== null) await this.mail.stop();
    await this.renderer.close();
    if (this.server !== null) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    await this.core.close();
  }
}
