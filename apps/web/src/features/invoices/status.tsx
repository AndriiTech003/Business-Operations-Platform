import type { InvoiceStatus } from '@bop/contracts';
import { Badge, type BadgeProps } from '@bop/ui';

export const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'];

const VARIANT: Record<InvoiceStatus, BadgeProps['variant']> = {
  draft: 'muted',
  sent: 'info',
  partially_paid: 'warning',
  paid: 'success',
  overdue: 'destructive',
  void: 'outline',
};

export function invoiceStatusLabel(s: InvoiceStatus): string {
  return s === 'partially_paid' ? 'Partially paid' : s.charAt(0).toUpperCase() + s.slice(1);
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <Badge
      variant={VARIANT[status] ?? 'secondary'}
      data-testid="invoice-status"
      data-status={status}
      className={status === 'void' ? 'line-through' : undefined}
    >
      {invoiceStatusLabel(status)}
    </Badge>
  );
}
