import { useEffect, useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceDto } from '@bop/contracts';
import { OperatorPanelSlot } from '../../lib/operator';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@bop/ui';
import {
  Ban,
  ChevronLeft,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  History,
  MessageSquare,
  RefreshCw,
  Save,
  Send,
  Wallet,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { api, downloadFile, errorMessage } from '../../lib/api';
import { fmtDate, fromDateInput, money, toIsoDateInput } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useAuth } from '../../app/auth';
import { ConflictDialog } from '../../components/record/ConflictDialog';
import { RecordPresenceProvider, PresenceAvatars, LockBanner } from '../../components/record/presence';
import { Timeline } from '../../components/record/Timeline';
import { Comments } from '../../components/record/Comments';
import { RelationValue } from '../../components/FieldValue';
import { RecordSkeleton } from '../../components/record/RecordLayout';
import { useRecord, useRecordUpdate } from '../../components/record/useRecord';
import { InvoiceLinesEditor, newLine, totalsOf, type EditableLine } from './InvoiceLinesEditor';
import { PaymentDialog, SendInvoiceDialog } from './InvoiceDialogs';
import { InvoiceStatusBadge } from './status';

const route = getRouteApi('/app/invoices/$id');

function toEditable(inv: InvoiceDto): EditableLine[] {
  return (inv.lines ?? []).map((l) =>
    newLine({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxRate: l.taxRate }),
  );
}

function Preview({ invoice }: { invoice: InvoiceDto }) {
  const query = useQuery({
    queryKey: keys.invoice.preview(invoice.id, invoice.version),
    queryFn: () => api.text(`/v1/invoices/${invoice.id}/preview`),
    placeholderData: (prev) => prev,
  });
  return (
    <Card className="flex min-h-[640px] flex-col overflow-hidden" data-testid="invoice-preview">
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" /> PDF preview
        </CardTitle>
        <div className="flex items-center gap-1">
          {query.isFetching ? <Spinner className="size-3" /> : null}
          <Button size="icon-xs" variant="ghost" aria-label="Refresh preview" onClick={() => void query.refetch()}>
            <RefreshCw />
          </Button>
        </div>
      </CardHeader>
      <div className="flex-1 bg-muted/40 p-3">
        {query.isLoading ? (
          <Skeleton className="h-full min-h-[560px] bg-card" />
        ) : query.isError ? (
          <EmptyState title="Preview unavailable" description={errorMessage(query.error)} />
        ) : (
          <iframe
            title={`Invoice ${invoice.number}`}
            sandbox=""
            srcDoc={query.data ?? ''}
            className="h-full min-h-[560px] w-full rounded-md border bg-white shadow-sm"
          />
        )}
      </div>
    </Card>
  );
}

function InvoiceView({ invoice }: { invoice: InvoiceDto }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = route.useSearch();
  const upd = useRecordUpdate<InvoiceDto>('invoice', invoice.id);
  const editable = invoice.status === 'draft' && can('records:write');
  const [lines, setLines] = useState<EditableLine[]>(() => toEditable(invoice));
  const [due, setDue] = useState(toIsoDateInput(invoice.dueDate));
  const [issue, setIssue] = useState(toIsoDateInput(invoice.issueDate));
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [dirty, setDirty] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setLines(toEditable(invoice));
    setDue(toIsoDateInput(invoice.dueDate));
    setIssue(toIsoDateInput(invoice.issueDate));
    setNotes(invoice.notes ?? '');
  }, [invoice, dirty]);

  const totals = useMemo(() => totalsOf(lines), [lines]);
  const invalidLines = lines.some((l) => l.description.trim() === '' || l.quantity <= 0);

  const save = () => {
    upd.update({
      lines: lines.map((l) => ({
        description: l.description.trim(),
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        taxRate: l.taxRate,
      })),
      dueDate: fromDateInput(due) ?? undefined,
      issueDate: fromDateInput(issue) ?? undefined,
      notes: notes.trim() === '' ? null : notes,
    });
    setDirty(false);
  };

  const voidMut = useMutation({
    mutationFn: () => api.post<InvoiceDto>(`/v1/invoices/${invoice.id}/void`, {}),
    onSuccess: (inv) => {
      qc.setQueryData(keys.invoice.detail(inv.id), inv);
      void qc.invalidateQueries({ queryKey: keys.invoice.lists() });
      toast.success(`Invoice ${inv.number} voided`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const copyLink = () => {
    void navigator.clipboard?.writeText(invoice.publicUrl).then(
      () => toast.success('Public link copied'),
      () => toast.error('Could not copy the link'),
    );
  };

  const change =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setDirty(true);
    };

  const canSend = can('invoices:send') && invoice.status !== 'void' && invoice.status !== 'paid';
  const canPay =
    can('records:write') && invoice.status !== 'void' && invoice.status !== 'draft' && invoice.balanceCents > 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <Link
        to="/invoices"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3" /> Invoices
      </Link>
      <header className="flex flex-wrap items-start gap-3 rounded-xl border bg-card p-4">
        <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileText className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tabular-nums" data-testid="record-title">
              {invoice.number}
            </h1>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            <RelationValue entity="company" id={invoice.companyId} label={invoice.company?.name} /> · Due{' '}
            {fmtDate(invoice.dueDate)} · Balance{' '}
            <span className="font-medium text-foreground tabular-nums">
              {money(invoice.balanceCents, invoice.currency)}
            </span>
          </p>
          <LockBanner />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PresenceAvatars />
          <OperatorPanelSlot record={{ type: 'invoice', id: invoice.id, label: invoice.number }} />
          {canSend ? (
            <Button size="sm" onClick={() => setSendOpen(true)} disabled={dirty} data-testid="invoice-send">
              <Send /> {invoice.sentAt ? 'Resend' : 'Send'}
            </Button>
          ) : null}
          {canPay ? (
            <Button size="sm" variant="outline" onClick={() => setPayOpen(true)} data-testid="invoice-record-payment">
              <Wallet /> Record payment
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={copyLink} data-testid="invoice-copy-link">
            <Copy /> Public link
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  void downloadFile(`/v1/invoices/${invoice.id}/pdf`, `${invoice.number}.pdf`).catch((e: unknown) =>
                    toast.error(errorMessage(e)),
                  )
                }
              >
                <Download /> Download PDF
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.open(invoice.publicUrl, '_blank', 'noopener')}>
                <ExternalLink /> Open public page
              </DropdownMenuItem>
              <DropdownMenuItem
                destructive
                disabled={!can('invoices:void') || invoice.status === 'void' || invoice.status === 'paid'}
                onSelect={() => setVoidOpen(true)}
                data-testid="invoice-void"
              >
                <Ban /> Void invoice
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Tabs
        value={search.tab ?? 'editor'}
        onValueChange={(tab) =>
          void navigate({ to: '/invoices/$id', params: { id: invoice.id }, search: { tab }, replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="editor" data-testid="tab-editor">
            <FileText /> Invoice
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            <History /> Activity
          </TabsTrigger>
          <TabsTrigger value="comments" data-testid="tab-comments">
            <MessageSquare /> Comments
          </TabsTrigger>
        </TabsList>
        <TabsContent value="editor">
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="grid content-start gap-4">
              {invoice.status === 'void' ? (
                <Alert variant="destructive" title="This invoice is void">
                  It no longer counts towards receivables.
                </Alert>
              ) : null}
              {!editable && invoice.status !== 'void' ? (
                <Alert variant="info" title="Sent invoices are locked">
                  Only drafts can be edited. Record payments or void the invoice instead.
                </Alert>
              ) : null}
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>Line items</CardTitle>
                  {editable ? (
                    <div className="flex items-center gap-2">
                      {dirty ? <span className="text-xs text-warning">Unsaved changes</span> : null}
                      {dirty ? (
                        <Button size="xs" variant="ghost" onClick={() => setDirty(false)}>
                          Discard
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={save}
                        disabled={!dirty || invalidLines}
                        loading={upd.mutation.isPending}
                        data-testid="invoice-save"
                      >
                        <Save /> Save
                      </Button>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Issue date" htmlFor="inv-issue">
                      <Input
                        id="inv-issue"
                        type="date"
                        disabled={!editable}
                        value={issue}
                        onChange={(e) => change(setIssue)(e.target.value)}
                      />
                    </Field>
                    <Field label="Due date" htmlFor="inv-due-edit">
                      <Input
                        id="inv-due-edit"
                        type="date"
                        disabled={!editable}
                        value={due}
                        onChange={(e) => change(setDue)(e.target.value)}
                        data-testid="field-dueDate"
                      />
                    </Field>
                  </div>
                  <InvoiceLinesEditor
                    lines={lines}
                    onChange={change(setLines)}
                    currency={invoice.currency}
                    readOnly={!editable}
                  />
                  {editable && invalidLines ? (
                    <p className="text-xs text-destructive">Every line needs a description and a positive quantity.</p>
                  ) : null}
                  <Field label="Notes" htmlFor="inv-notes">
                    <Textarea
                      id="inv-notes"
                      disabled={!editable}
                      value={notes}
                      onChange={(e) => change(setNotes)(e.target.value)}
                      placeholder="Payment terms, thank-you note…"
                    />
                  </Field>
                  {dirty ? (
                    <p className="text-xs text-muted-foreground">
                      New total {money(totals.totalCents, invoice.currency)} (saved{' '}
                      {money(invoice.totalCents, invoice.currency)}). Save to refresh the PDF preview.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Payments</CardTitle>
                </CardHeader>
                <CardContent>
                  {(invoice.payments ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No payments yet.</p>
                  ) : (
                    <ul className="divide-y text-sm" data-testid="payments">
                      {invoice.payments?.map((p) => (
                        <li key={p.id} className="flex items-center gap-3 py-2">
                          <Wallet className="size-4 text-success" />
                          <span className="flex-1">
                            {fmtDate(p.paidAt)} · {p.method.replace(/_/g, ' ')}
                            {p.reference ? ` · ${p.reference}` : ''}
                          </span>
                          <span className="font-medium tabular-nums">{money(p.amountCents, invoice.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex justify-between border-t pt-2 text-sm">
                    <span className="text-muted-foreground">Paid {money(invoice.paidCents, invoice.currency)}</span>
                    <span className="font-semibold">Balance {money(invoice.balanceCents, invoice.currency)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
            <Preview invoice={invoice} />
          </div>
        </TabsContent>
        <TabsContent value="activity">
          <Timeline entity="invoice" id={invoice.id} />
        </TabsContent>
        <TabsContent value="comments">
          <Comments entity="invoice" id={invoice.id} />
        </TabsContent>
      </Tabs>

      <SendInvoiceDialog invoice={invoice} open={sendOpen} onOpenChange={setSendOpen} />
      <PaymentDialog invoice={invoice} open={payOpen} onOpenChange={setPayOpen} />
      <ConfirmDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Void invoice ${invoice.number}?`}
        description="Voiding cannot be undone. The customer's public link will show the invoice as void."
        destructive
        confirmLabel="Void invoice"
        confirmTestId="confirm-void"
        onConfirm={() => voidMut.mutate()}
      />
      {upd.conflict ? (
        <ConflictDialog
          open
          mine={upd.conflict.mine}
          current={upd.conflict.current}
          onOverwrite={upd.overwrite}
          onTakeTheirs={upd.takeTheirs}
          onClose={upd.dismissConflict}
        />
      ) : null}
    </div>
  );
}

export function InvoicePage() {
  const { id } = route.useParams();
  const query = useRecord<InvoiceDto>('invoice', id);
  if (query.isLoading) return <RecordSkeleton />;
  if (query.isError || query.data === undefined)
    return (
      <EmptyState
        className="m-6"
        icon={<FileText />}
        title="Invoice not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  return (
    <RecordPresenceProvider entity="invoice" id={id}>
      <InvoiceView invoice={query.data} />
    </RecordPresenceProvider>
  );
}
