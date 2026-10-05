import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceDto } from '@bop/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  Textarea,
  toast,
} from '@bop/ui';
import { Paperclip, Send, Wallet } from 'lucide-react';
import { api, errorMessage, newIdempotencyKey } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { fromDateInput, money, toIsoDateInput } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useEmailTemplates } from '../../lib/data';
import { MoneyInput } from '../../components/FieldInput';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function SendInvoiceDialog({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: InvoiceDto;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const qc = useQueryClient();
  const [to, setTo] = useState(invoice.contact?.email ?? '');
  const templates = useEmailTemplates(open);
  const template = templates.data?.find((t) => t.key === 'invoice_sent');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const keyRef = useRef(newIdempotencyKey());
  const debouncedJson = useDebounced(JSON.stringify({ subject, message }), 400);
  const debounced = JSON.parse(debouncedJson) as { subject: string; message: string };
  const preview = useQuery({
    queryKey: ['invoice-email-preview', invoice.id, debouncedJson],
    queryFn: () =>
      api.post<{ subject: string; html: string }>('/v1/email-templates/preview', {
        subject:
          debounced.subject.trim() !== ''
            ? debounced.subject.replace(/\{\{/g, '{ {')
            : (template?.subject ?? `Invoice {{ invoice.number }}`),
        body: `${debounced.message.trim() !== '' ? `<p>${escapeHtml(debounced.message).replace(/\{\{/g, '{ {')}</p>` : ''}${template?.body ?? ''}`,
        entity: 'invoice',
        id: invoice.id,
      }),
    enabled: open && !templates.isLoading,
    retry: false,
  });
  useEffect(() => {
    if (open) keyRef.current = newIdempotencyKey();
  }, [open]);
  const recipients = to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const send = useMutation({
    mutationFn: () =>
      api.post<InvoiceDto>(
        `/v1/invoices/${invoice.id}/send`,
        {
          to: recipients,
          ...(subject.trim() !== '' ? { subject: subject.trim() } : {}),
          ...(message.trim() !== '' ? { message: message.trim() } : {}),
        },
        { idempotencyKey: keyRef.current },
      ),
    onSuccess: (inv) => {
      qc.setQueryData(keys.invoice.detail(inv.id), inv);
      void qc.invalidateQueries({ queryKey: keys.invoice.all });
      toast.success(`Invoice ${inv.number} sent to ${recipients.join(', ')}`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="send-invoice-dialog">
        <DialogHeader>
          <DialogTitle>Send invoice {invoice.number}</DialogTitle>
          <DialogDescription>
            Uses the “Invoice sent” email template with the PDF attached. Add an optional personal message above it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <Field label="To" htmlFor="send-to" hint="Separate several addresses with commas">
              <Input id="send-to" data-testid="field-to" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Subject" htmlFor="send-subject">
              <Input
                id="send-subject"
                data-testid="field-subject"
                value={subject}
                placeholder={preview.data?.subject ?? 'From the template'}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
            <Field label="Personal message (optional)" htmlFor="send-message">
              <Textarea
                id="send-message"
                data-testid="field-message"
                className="min-h-40"
                placeholder="Thanks for your business! Let me know if you have questions."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid content-start gap-2" data-testid="email-preview">
            <p className="text-xs font-medium text-muted-foreground">Preview</p>
            <div className="overflow-hidden rounded-lg border">
              <div className="grid gap-0.5 border-b bg-muted/40 px-3 py-2 text-xs">
                <span>
                  <span className="text-muted-foreground">To:</span> {recipients.join(', ') || '—'}
                </span>
                <span>
                  <span className="text-muted-foreground">Subject:</span>{' '}
                  <span className="font-medium">{subject.trim() !== '' ? subject : (preview.data?.subject ?? '')}</span>
                </span>
              </div>
              {preview.isLoading ? (
                <Skeleton className="m-3 h-40" />
              ) : preview.isError ? (
                <p className="p-3 text-xs text-destructive">{errorMessage(preview.error)}</p>
              ) : (
                <iframe
                  title="Email preview"
                  sandbox=""
                  className="h-64 w-full bg-white"
                  srcDoc={preview.data?.html ?? ''}
                />
              )}
              <div className="border-t px-3 py-2">
                <Badge variant="secondary">
                  <Paperclip /> {invoice.number}.pdf
                </Badge>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="dialog-submit"
            disabled={recipients.length === 0}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            <Send /> Send invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PaymentDialog({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: InvoiceDto;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState<number | null>(invoice.balanceCents);
  const [method, setMethod] = useState('bank_transfer');
  const [date, setDate] = useState(toIsoDateInput(new Date().toISOString()));
  const [reference, setReference] = useState('');
  const keyRef = useRef(newIdempotencyKey());
  useEffect(() => {
    if (open) {
      keyRef.current = newIdempotencyKey();
      setAmount(invoice.balanceCents);
    }
  }, [open, invoice.balanceCents]);
  const pay = useMutation({
    mutationFn: () =>
      api.post<InvoiceDto>(
        `/v1/invoices/${invoice.id}/payments`,
        { amountCents: amount, method, paidAt: fromDateInput(date) ?? undefined, reference: reference || null },
        { idempotencyKey: keyRef.current },
      ),
    onSuccess: (inv) => {
      qc.setQueryData(keys.invoice.detail(inv.id), inv);
      void qc.invalidateQueries({ queryKey: keys.invoice.all });
      toast.success(`Payment of ${money(amount ?? 0, invoice.currency)} recorded`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>Outstanding balance {money(invoice.balanceCents, invoice.currency)}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (amount !== null && amount > 0) pay.mutate();
          }}
        >
          <Field label={`Amount (${invoice.currency})`}>
            <MoneyInput value={amount} onChange={setAmount} testId="field-amountCents" autoFocus />
          </Field>
          <Field label="Method" htmlFor="pay-method">
            <NativeSelect
              id="pay-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              data-testid="field-method"
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </NativeSelect>
          </Field>
          <Field label="Paid on" htmlFor="pay-date">
            <Input
              id="pay-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="field-paidAt"
            />
          </Field>
          <Field label="Reference" htmlFor="pay-ref">
            <Input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              data-testid="field-reference"
            />
          </Field>
          {amount !== null && amount > invoice.balanceCents ? (
            <p className="text-xs text-warning">Amount exceeds the outstanding balance.</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="dialog-submit"
              disabled={amount === null || amount <= 0}
              loading={pay.isPending}
            >
              <Wallet /> Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
