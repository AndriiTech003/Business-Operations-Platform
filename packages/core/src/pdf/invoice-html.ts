import { formatCents, type InvoiceDto } from '@bop/contracts';
import { escapeHtml } from '../services/invoices';

export interface InvoiceHtmlInput {
  invoice: InvoiceDto;
  seller: { name: string };
  buyer: { name: string; domain: string | null };
  contact: { name: string; email: string | null } | null;
}

const date = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function renderInvoiceHtml(input: InvoiceHtmlInput): string {
  const { invoice } = input;
  const money = (c: number) => escapeHtml(formatCents(c, invoice.currency));
  const rows = (invoice.lines ?? [])
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.description)}</td><td class="n">${l.quantity}</td><td class="n">${money(l.unitPriceCents)}</td><td class="n">${l.taxRate}%</td><td class="n">${money(l.amountCents)}</td></tr>`,
    )
    .join('');
  const status =
    invoice.status === 'void'
      ? '<div class="stamp void">VOID</div>'
      : invoice.status === 'paid'
        ? '<div class="stamp paid">PAID</div>'
        : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${escapeHtml(invoice.number)}</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;margin:0;padding:40px;font-size:13px;position:relative}
h1{font-size:28px;margin:0 0 4px}.muted{color:#6b7280}.head{display:flex;justify-content:space-between;margin-bottom:32px}
.parties{display:flex;gap:48px;margin-bottom:24px}.parties h3{font-size:11px;text-transform:uppercase;color:#6b7280;margin:0 0 4px;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;margin-top:8px}th{text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:1px solid #e5e7eb;padding:8px 4px}
td{padding:8px 4px;border-bottom:1px solid #f3f4f6}.n{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:280px;margin-top:16px}
.totals div{display:flex;justify-content:space-between;padding:4px 0}.totals .grand{font-weight:700;font-size:16px;border-top:2px solid #111827;padding-top:8px}
.stamp{position:absolute;top:120px;right:60px;font-size:48px;font-weight:800;transform:rotate(-15deg);opacity:.25}.paid{color:#059669}.void{color:#dc2626}
.notes{margin-top:32px;white-space:pre-wrap}
</style></head><body>
${status}
<div class="head"><div><h1>Invoice</h1><div class="muted">${escapeHtml(invoice.number)}</div></div>
<div style="text-align:right"><strong>${escapeHtml(input.seller.name)}</strong><div class="muted">Issued ${date(invoice.issueDate)}</div><div class="muted">Due ${date(invoice.dueDate)}</div></div></div>
<div class="parties"><div><h3>Bill to</h3><strong>${escapeHtml(input.buyer.name)}</strong>${input.buyer.domain ? `<div class="muted">${escapeHtml(input.buyer.domain)}</div>` : ''}${
    input.contact
      ? `<div>${escapeHtml(input.contact.name)}</div>${input.contact.email ? `<div class="muted">${escapeHtml(input.contact.email)}</div>` : ''}`
      : ''
  }</div></div>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Tax</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="totals"><div><span>Subtotal</span><span>${money(invoice.subtotalCents)}</span></div><div><span>Tax</span><span>${money(invoice.taxCents)}</span></div>
<div class="grand"><span>Total</span><span>${money(invoice.totalCents)}</span></div>${
    invoice.paidCents > 0
      ? `<div><span>Paid</span><span>${money(invoice.paidCents)}</span></div><div><strong>Balance due</strong><strong>${money(invoice.balanceCents)}</strong></div>`
      : ''
  }</div>
${invoice.notes ? `<div class="notes">${escapeHtml(invoice.notes)}</div>` : ''}
</body></html>`;
}
