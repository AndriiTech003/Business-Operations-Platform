export interface LineTotals {
  amountCents: number;
  taxCents: number;
}

export function lineTotals(quantity: number, unitPriceCents: number, taxRate: number): LineTotals {
  const amountCents = Math.round(quantity * unitPriceCents);
  const taxCents = Math.round((amountCents * taxRate) / 100);
  return { amountCents, taxCents };
}

export interface InvoiceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function invoiceTotals(
  lines: Array<{ quantity: number; unitPriceCents: number; taxRate: number }>,
): InvoiceTotals {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    const totals = lineTotals(line.quantity, line.unitPriceCents, line.taxRate);
    subtotalCents += totals.amountCents;
    taxCents += totals.taxCents;
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function formatCents(cents: number, currency: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function fractionalPosition(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return (after as number) - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}
