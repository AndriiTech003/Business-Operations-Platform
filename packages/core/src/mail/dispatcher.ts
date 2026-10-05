import nodemailer, { type Transporter } from 'nodemailer';
import type { CoreDeps } from '../deps';
import { runInContext } from '../context';
import type { EmailMessage } from '../generated/prisma/client';
import type { InvoiceDocuments } from '../pdf/invoice-pdf';
import type { PdfRenderer } from '../pdf/renderer';
import type { EmailsService } from '../services/emails';

const MAX_ATTEMPTS = 5;

export class MailDispatcher {
  private readonly transport: Transporter;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly deps: CoreDeps,
    private readonly emails: EmailsService,
    private readonly documents: InvoiceDocuments,
    private readonly renderer: PdfRenderer,
  ) {
    this.transport = nodemailer.createTransport(deps.config.smtpUrl);
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      await this.runOnce().catch((error: unknown) => this.deps.logger.error({ err: error }, 'mail dispatch failed'));
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.deps.config.engine.emailPollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.transport.close();
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = new Date();
      const candidates = await this.deps.db.system.emailMessage.findMany({
        where: {
          OR: [
            { status: 'queued', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
            { status: 'sending', leaseUntil: { lte: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      let sent = 0;
      for (const msg of candidates) if (await this.dispatch(msg)) sent += 1;
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async withinRate(tenantId: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${this.deps.config.redisPrefix}:mailrate:${tenantId}:${minute}`;
    const count = await this.deps.redis.incr(key);
    if (count === 1) await this.deps.redis.expire(key, 120);
    if (count > this.deps.config.engine.emailsPerMinute) {
      await this.deps.redis.decr(key);
      return false;
    }
    return true;
  }

  private async dispatch(msg: EmailMessage): Promise<boolean> {
    const leaseUntil = new Date(Date.now() + this.deps.config.engine.emailLeaseMs);
    const claimed = await this.deps.db.system.emailMessage.updateMany({
      where: { id: msg.id, status: msg.status, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
      data: { status: 'sending', leaseUntil, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return false;
    if (!(await this.withinRate(msg.tenantId))) {
      await this.deps.db.system.emailMessage.updateMany({
        where: { id: msg.id, status: 'sending' },
        data: { status: 'queued', leaseUntil: new Date(Date.now() + 5000), attempts: { decrement: 1 } },
      });
      return false;
    }
    return runInContext({ tenantId: msg.tenantId, actor: { type: 'system', id: null }, causation: [] }, async () => {
      try {
        const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
        if (msg.attachInvoice !== null) {
          const invoice = await this.deps.db.scoped.invoice.findFirst({
            where: { id: msg.attachInvoice },
            select: { number: true },
          });
          const pdf = await this.documents.ensurePdf(msg.attachInvoice, this.renderer);
          attachments.push({
            filename: `${invoice?.number ?? 'invoice'}.pdf`,
            content: pdf.bytes,
            contentType: 'application/pdf',
          });
        }
        const messageId = `<${msg.id}@bop.local>`;
        await this.transport.sendMail({
          from: this.deps.config.mailFrom,
          to: msg.toAddresses,
          cc: msg.ccAddresses.length > 0 ? msg.ccAddresses : undefined,
          subject: msg.subject,
          html: msg.html,
          text: msg.text ?? undefined,
          messageId,
          headers: msg.idempotencyKey === null ? {} : { 'X-Idempotency-Key': msg.idempotencyKey },
          attachments,
        });
        await this.emails.markSent(msg, messageId);
        this.deps.metrics.emailsSent.inc({ result: 'sent' });
        return true;
      } catch (error) {
        const attempts = msg.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        this.deps.metrics.emailsSent.inc({ result: failed ? 'failed' : 'retry' });
        this.deps.logger.warn({ err: (error as Error).message, emailId: msg.id, attempts }, 'email delivery failed');
        await this.deps.db.system.emailMessage.updateMany({
          where: { id: msg.id, status: 'sending' },
          data: {
            status: failed ? 'failed' : 'queued',
            error: (error as Error).message.slice(0, 1000),
            leaseUntil: failed ? null : new Date(Date.now() + 2 ** attempts * 1000),
          },
        });
        return false;
      }
    });
  }
}
