import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { PublicInvoiceDto } from '@bop/contracts';
import { Alert, Button, Card, EmptyState, Skeleton, toast } from '@bop/ui';
import { CircleCheck, Download, FileText, Wallet } from 'lucide-react';
import { API_URL, api, errorMessage } from '../../lib/api';
import { fmtDate, money } from '../../lib/format';
import { InvoiceStatusBadge } from './status';

const route = getRouteApi('/p/invoices/$token');

export function PublicInvoicePage() {
  const { token } = route.useParams();
  const qc = useQueryClient();
  const key = ['public-invoice', token];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<PublicInvoiceDto>(`/p/invoices/${encodeURIComponent(token)}`, { auth: false }),
    retry: false,
  });
  const pay = useMutation({
    mutationFn: () => api.post<PublicInvoiceDto>(`/p/invoices/${encodeURIComponent(token)}/pay`, {}, { auth: false }),
    onSuccess: (inv) => {
      qc.setQueryData(key, inv);
      toast.success('Thank you! The invoice is marked as paid.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const inv = query.data;
  return (
    <div className="min-h-full bg-muted/40 px-4 py-10">
      <div className="mx-auto grid max-w-3xl gap-4">
        {query.isLoading ? (
          <Skeleton className="h-[520px] bg-card" />
        ) : query.isError || inv === undefined ? (
          <EmptyState
            icon={<FileText />}
            title="Invoice not found"
            description="The link may be wrong or the invoice was removed."
            className="bg-card"
          />
        ) : (
          <>
            <Card className="overflow-hidden" data-testid="public-invoice">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b bg-gradient-to-br from-primary/10 to-transparent p-6">
                <div>
                  <p className="text-sm text-muted-foreground">{inv.seller}</p>
                  <h1 className="mt-1 text-2xl font-semibold tabular-nums">Invoice {inv.number}</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Issued {fmtDate(inv.issueDate)} · Due {fmtDate(inv.dueDate)}
                  </p>
                </div>
                <div className="grid justify-items-end gap-2">
                  <InvoiceStatusBadge status={inv.status} />
                  <p className="text-xs text-muted-foreground">Amount due</p>
                  <p className="text-2xl font-bold tabular-nums" data-testid="public-balance">
                    {money(inv.balanceCents, inv.currency)}
                  </p>
                </div>
              </div>
              <div className="grid gap-6 p-6">
                <div className="text-sm">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Bill to</p>
                  <p className="font-medium">{inv.buyer}</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 text-left font-medium">Description</th>
                      <th className="py-2 text-right font-medium">Qty</th>
                      <th className="py-2 text-right font-medium">Unit price</th>
                      <th className="py-2 text-right font-medium">Tax</th>
                      <th className="py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lines.map((l) => (
                      <tr key={l.id} className="border-b last:border-0">
                        <td className="py-2">{l.description}</td>
                        <td className="py-2 text-right tabular-nums">{l.quantity}</td>
                        <td className="py-2 text-right tabular-nums">{money(l.unitPriceCents, inv.currency)}</td>
                        <td className="py-2 text-right tabular-nums">{l.taxRate}%</td>
                        <td className="py-2 text-right tabular-nums">{money(l.amountCents, inv.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <dl className="ml-auto grid w-64 gap-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Subtotal</dt>
                    <dd className="tabular-nums">{money(inv.subtotalCents, inv.currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Tax</dt>
                    <dd className="tabular-nums">{money(inv.taxCents, inv.currency)}</dd>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-semibold">
                    <dt>Total</dt>
                    <dd className="tabular-nums">{money(inv.totalCents, inv.currency)}</dd>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <dt>Paid</dt>
                    <dd className="tabular-nums">{money(inv.paidCents, inv.currency)}</dd>
                  </div>
                </dl>
                {inv.notes ? (
                  <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">{inv.notes}</p>
                ) : null}
              </div>
            </Card>
            {inv.status === 'paid' ? (
              <Alert icon={<CircleCheck className="text-success" />} title="Paid in full">
                Thank you for your payment.
              </Alert>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" asChild>
                <a
                  href={`${API_URL}/p/invoices/${encodeURIComponent(token)}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="public-pdf"
                >
                  <Download /> Download PDF
                </a>
              </Button>
              {inv.balanceCents > 0 && inv.status !== 'void' && inv.status !== 'draft' ? (
                <Button onClick={() => pay.mutate()} loading={pay.isPending} data-testid="public-mark-paid">
                  <Wallet /> Mark as paid (demo)
                </Button>
              ) : null}
            </div>
            <p className="text-center text-xs text-muted-foreground">Demo payment page — no real money moves.</p>
          </>
        )}
      </div>
    </div>
  );
}
