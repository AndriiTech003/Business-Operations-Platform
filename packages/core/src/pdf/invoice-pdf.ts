import type { CoreDeps } from '../deps';
import { requireTenantId } from '../context';
import { notFound } from '../errors';
import type { InvoicesService } from '../services/invoices';
import { renderInvoiceHtml } from './invoice-html';
import type { PdfRenderer } from './renderer';

export class InvoiceDocuments {
  constructor(
    private readonly deps: CoreDeps,
    private readonly invoices: InvoicesService,
  ) {}

  async html(invoiceId: string): Promise<string> {
    const invoice = await this.invoices.get(invoiceId);
    const [tenant, company, contact] = await Promise.all([
      this.deps.db.system.tenant.findUnique({ where: { id: requireTenantId() } }),
      this.deps.db.scoped.company.findFirst({ where: { id: invoice.companyId } }),
      invoice.contactId === null ? null : this.deps.db.scoped.contact.findFirst({ where: { id: invoice.contactId } }),
    ]);
    return renderInvoiceHtml({
      invoice,
      seller: { name: tenant?.name ?? '' },
      buyer: { name: company?.name ?? '', domain: company?.domain ?? null },
      contact:
        contact === null ? null : { name: `${contact.firstName} ${contact.lastName}`.trim(), email: contact.email },
    });
  }

  async ensurePdf(invoiceId: string, renderer: PdfRenderer): Promise<{ key: string; bytes: Buffer }> {
    const row = await this.deps.db.scoped.invoice.findFirst({ where: { id: invoiceId } });
    if (row === null) throw notFound('Invoice');
    if (row.pdfKey !== null && row.pdfVersion === row.version) {
      const bytes = await this.deps.storage.get(row.pdfKey);
      if (bytes !== null) return { key: row.pdfKey, bytes };
    }
    const bytes = await renderer.render(await this.html(invoiceId));
    const key = await this.deps.storage.put(
      `tenants/${row.tenantId}/invoices/${row.id}-v${row.version}.pdf`,
      bytes,
      'application/pdf',
    );
    await this.deps.db.scoped.invoice.updateMany({
      where: { id: invoiceId, version: row.version },
      data: { pdfKey: key, pdfVersion: row.version },
    });
    return { key, bytes };
  }

  async cachedPdf(invoiceId: string): Promise<Buffer | null> {
    const row = await this.deps.db.scoped.invoice.findFirst({ where: { id: invoiceId } });
    if (row === null) throw notFound('Invoice');
    if (row.pdfKey === null || row.pdfVersion !== row.version) return null;
    return this.deps.storage.get(row.pdfKey);
  }
}
