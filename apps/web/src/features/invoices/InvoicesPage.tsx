import { useMemo, useRef, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvoiceDto } from '@bop/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  toast,
} from '@bop/ui';
import { Plus, Receipt } from 'lucide-react';
import { DataTable, type ColumnSpec } from '../../components/data-table/DataTable';
import { Page, PageHeader } from '../../components/PageHeader';
import { RelationValue } from '../../components/FieldValue';
import { RecordPicker } from '../../components/pickers';
import { api, errorMessage, newIdempotencyKey } from '../../lib/api';
import { fromDateInput, money, toIsoDateInput } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useRecordList } from '../../lib/records';
import type { TableSearch } from '../../lib/table';
import { useAuth, useMe } from '../../app/auth';
import { INVOICE_STATUSES, InvoiceStatusBadge, invoiceStatusLabel } from './status';

const route = getRouteApi('/app/invoices');

const COLUMNS: ColumnSpec<InvoiceDto>[] = [
  {
    key: 'number',
    label: 'Number',
    type: 'text',
    width: 150,
    render: (r) => <span className="font-medium tabular-nums">{r.number}</span>,
  },
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: INVOICE_STATUSES,
    optionLabels: Object.fromEntries(INVOICE_STATUSES.map((s) => [s, invoiceStatusLabel(s)])),
    width: 130,
    render: (r) => <InvoiceStatusBadge status={r.status} />,
  },
  {
    key: 'companyId',
    label: 'Company',
    type: 'relation',
    relationEntity: 'company',
    width: 200,
    render: (r) => <RelationValue entity="company" id={r.companyId} label={r.company?.name} />,
  },
  {
    key: 'contactId',
    label: 'Contact',
    type: 'relation',
    relationEntity: 'contact',
    width: 170,
    render: (r) => <RelationValue entity="contact" id={r.contactId} label={r.contact?.name} />,
  },
  { key: 'issueDate', label: 'Issued', type: 'date', width: 120 },
  { key: 'dueDate', label: 'Due', type: 'date', width: 120 },
  {
    key: 'totalCents',
    label: 'Total',
    type: 'money',
    width: 130,
    render: (r) => <span className="tabular-nums">{money(r.totalCents, r.currency)}</span>,
  },
  {
    key: 'balanceCents',
    label: 'Balance',
    type: 'money',
    width: 130,
    render: (r) => <span className="tabular-nums">{money(r.balanceCents, r.currency)}</span>,
  },
  { key: 'sentAt', label: 'Sent', type: 'date', width: 120 },
  { key: 'createdAt', label: 'Created', type: 'date', width: 120 },
];
const DEFAULT_COLUMNS = ['number', 'status', 'companyId', 'issueDate', 'dueDate', 'totalCents', 'balanceCents'];

export function CreateInvoiceDialog({
  open,
  onOpenChange,
  companyId,
  dealId,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  companyId?: string;
  dealId?: string;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [company, setCompany] = useState<string | null>(companyId ?? null);
  const [contact, setContact] = useState<string | null>(null);
  const [due, setDue] = useState(() => toIsoDateInput(new Date(Date.now() + 14 * 86_400_000).toISOString()));
  const [currency, setCurrency] = useState(me.tenant.settings.currency);
  const keyRef = useRef(newIdempotencyKey());
  const create = useMutation({
    mutationFn: () =>
      api.post<InvoiceDto>(
        '/v1/invoices',
        {
          companyId: company,
          contactId: contact,
          dealId: dealId ?? null,
          currency,
          dueDate: fromDateInput(due) ?? undefined,
          lines: [],
        },
        { idempotencyKey: keyRef.current },
      ),
    onSuccess: (inv) => {
      keyRef.current = newIdempotencyKey();
      toast.success(`Draft ${inv.number} created`);
      void qc.invalidateQueries({ queryKey: keys.invoice.lists() });
      onOpenChange(false);
      void navigate({ to: '/invoices/$id', params: { id: inv.id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>Creates a draft. Add line items on the next screen.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (company !== null) create.mutate();
          }}
        >
          <Field label="Company" required>
            <RecordPicker entity="company" value={company} onChange={(v) => setCompany(v)} testId="field-companyId" />
          </Field>
          <Field label="Contact">
            <RecordPicker entity="contact" value={contact} onChange={(v) => setContact(v)} testId="field-contactId" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due date" htmlFor="inv-due">
              <Input
                id="inv-due"
                type="date"
                data-testid="field-dueDate"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>
            <Field label="Currency" htmlFor="inv-currency">
              <Input
                id="inv-currency"
                data-testid="field-currency"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="dialog-submit" disabled={company === null} loading={create.isPending}>
              Create draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InvoicesPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useRecordList<InvoiceDto>('invoice', search);
  const [creating, setCreating] = useState(false);
  const columns = useMemo(() => COLUMNS, []);
  const setSearch = (next: TableSearch) => void navigate({ to: '/invoices', search: next, replace: true });
  return (
    <Page>
      <PageHeader
        icon={<Receipt />}
        title="Invoices"
        description="Billing, payments and receivables"
        actions={
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            disabled={!can('records:write')}
            data-testid="create-invoice"
          >
            <Plus /> New invoice
          </Button>
        }
      />
      <DataTable
        entity="invoices"
        columns={columns}
        defaultColumns={DEFAULT_COLUMNS}
        search={search}
        onSearchChange={setSearch}
        query={query}
        searchPlaceholder="Search by number or company…"
        currencyOf={(r) => r.currency}
        onRowClick={(r) => void navigate({ to: '/invoices/$id', params: { id: r.id } })}
      />
      <CreateInvoiceDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
