import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { CompanyDto, ContactDto, DealDto, InvoiceDto } from '@bop/contracts';
import {
  Badge,
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
  toast,
} from '@bop/ui';
import { Building, Ellipsis, FileText, Globe, Handshake, Play, Trash2, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCustomFieldsFor } from '../../lib/data';
import { fmtDate, money } from '../../lib/format';
import { useAuth, useMe } from '../../app/auth';
import { ConflictDialog } from '../../components/record/ConflictDialog';
import { CustomFieldsSection } from '../../components/record/CustomFieldsSection';
import { InlineField } from '../../components/record/InlineField';
import { RecordLayout, RecordSkeleton, TAB_ICONS } from '../../components/record/RecordLayout';
import { RecordPresenceProvider } from '../../components/record/presence';
import { RecordTasks } from '../../components/record/RecordTasks';
import { RelatedList } from '../../components/record/RelatedList';
import { RunWorkflowDialog } from '../../components/record/RunWorkflowDialog';
import { Timeline } from '../../components/record/Timeline';
import { Comments } from '../../components/record/Comments';
import { UserName } from '../../components/FieldValue';
import { useRecord, useRecordUpdate } from '../../components/record/useRecord';
import { InvoiceStatusBadge } from '../invoices/status';

const route = getRouteApi('/app/companies/$id');

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function CompanyView({ company }: { company: CompanyDto }) {
  const me = useMe();
  const { can } = useAuth();
  const search = route.useSearch();
  const navigate = useNavigate();
  const defs = useCustomFieldsFor('company');
  const upd = useRecordUpdate<CompanyDto>('company', company.id);
  const [runOpen, setRunOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !can('records:write');
  const currency = me.tenant.settings.currency;
  const remove = useMutation({
    mutationFn: () => api.del(`/v1/companies/${company.id}`),
    onSuccess: () => {
      toast.success('Company deleted');
      void navigate({ to: '/companies' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <RecordLayout
        backTo="/companies"
        backLabel="Companies"
        record={{ type: 'company', id: company.id, label: company.name }}
        icon={<Building />}
        title={company.name}
        subtitle={
          company.domain ? (
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3" /> {company.domain}
            </span>
          ) : (
            'No domain'
          )
        }
        badges={company.tags.map((t) => (
          <Badge key={t} variant="secondary">
            {t}
          </Badge>
        ))}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setRunOpen(true)} data-testid="run-workflow">
              <Play /> Run workflow…
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem destructive disabled={readOnly} onSelect={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete company
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        headerFields={
          <>
            <InlineField
              spec={{ key: 'name', label: 'Name', type: 'text' }}
              value={company.name}
              readOnly={readOnly}
              onSave={(v) => upd.update({ name: v })}
            />
            <InlineField
              spec={{ key: 'domain', label: 'Domain', type: 'text' }}
              value={company.domain}
              readOnly={readOnly}
              onSave={(v) => upd.update({ domain: v })}
            />
            <InlineField
              spec={{ key: 'industry', label: 'Industry', type: 'text' }}
              value={company.industry}
              readOnly={readOnly}
              onSave={(v) => upd.update({ industry: v })}
            />
            <InlineField
              spec={{ key: 'ownerId', label: 'Owner', type: 'user' }}
              value={company.ownerId}
              display={<UserName id={company.ownerId} name={company.owner?.name} />}
              readOnly={readOnly}
              onSave={(v) => upd.update({ ownerId: v })}
            />
          </>
        }
        tab={search.tab}
        onTabChange={(tab) =>
          void navigate({ to: '/companies/$id', params: { id: company.id }, search: { tab }, replace: true })
        }
        tabs={[
          {
            value: 'overview',
            label: 'Overview',
            icon: TAB_ICONS.overview,
            content: (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="grid content-start gap-4">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Stat label="Contacts" value={company.stats?.contacts ?? 0} />
                    <Stat label="Open deals" value={company.stats?.openDeals ?? 0} />
                    <Stat label="Pipeline" value={money(company.stats?.openDealsCents ?? 0, currency)} />
                    <Stat label="Unpaid invoices" value={money(company.stats?.unpaidInvoicesCents ?? 0, currency)} />
                  </div>
                  <Card>
                    <CardHeader>
                      <CardTitle>Details</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-1">
                      <InlineField
                        layout="row"
                        spec={{ key: 'size', label: 'Employees', type: 'number' }}
                        value={company.size}
                        readOnly={readOnly}
                        onSave={(v) => upd.update({ size: v })}
                      />
                      <div className="grid grid-cols-[140px_1fr] items-center gap-2 px-0 py-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">Created</span>
                        <span className="px-2">{fmtDate(company.createdAt)}</span>
                      </div>
                      <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">Last updated</span>
                        <span className="px-2">{fmtDate(company.updatedAt)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
                <CustomFieldsSection
                  defs={defs}
                  values={company.custom}
                  readOnly={readOnly}
                  onSave={(key, v) => upd.update({ custom: { [key]: v } })}
                />
              </div>
            ),
          },
          {
            value: 'activity',
            label: 'Activity',
            icon: TAB_ICONS.activity,
            content: <Timeline entity="company" id={company.id} />,
          },
          {
            value: 'tasks',
            label: 'Tasks',
            icon: TAB_ICONS.tasks,
            content: <RecordTasks entity="company" id={company.id} title={company.name} />,
          },
          {
            value: 'related',
            label: 'Related',
            icon: TAB_ICONS.related,
            content: (
              <div className="grid gap-4 lg:grid-cols-3">
                <RelatedList<ContactDto>
                  title="Contacts"
                  icon={<Users />}
                  entity="contact"
                  parent={{ entity: 'company', id: company.id }}
                  field="companyId"
                  value={company.id}
                  primary={(c) => c.name}
                  secondary={(c) => c.title ?? c.email ?? ''}
                />
                <RelatedList<DealDto>
                  title="Deals"
                  icon={<Handshake />}
                  entity="deal"
                  parent={{ entity: 'company', id: company.id }}
                  field="companyId"
                  value={company.id}
                  primary={(d) => d.title}
                  secondary={(d) => d.stage?.name ?? ''}
                  trailing={(d) => <span className="text-sm tabular-nums">{money(d.amountCents, d.currency)}</span>}
                />
                <RelatedList<InvoiceDto>
                  title="Invoices"
                  icon={<FileText />}
                  entity="invoice"
                  parent={{ entity: 'company', id: company.id }}
                  field="companyId"
                  value={company.id}
                  primary={(i) => i.number}
                  secondary={(i) => `Due ${fmtDate(i.dueDate)} · ${money(i.totalCents, i.currency)}`}
                  trailing={(i) => <InvoiceStatusBadge status={i.status} />}
                />
              </div>
            ),
          },
          {
            value: 'comments',
            label: 'Comments',
            icon: TAB_ICONS.comments,
            content: <Comments entity="company" id={company.id} />,
          },
        ]}
      />
      <RunWorkflowDialog entity="company" id={company.id} open={runOpen} onOpenChange={setRunOpen} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${company.name}?`}
        description="The company is soft-deleted and disappears from lists."
        destructive
        confirmLabel="Delete"
        onConfirm={() => remove.mutate()}
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
    </>
  );
}

export function CompanyPage() {
  const { id } = route.useParams();
  const query = useRecord<CompanyDto>('company', id);
  if (query.isLoading) return <RecordSkeleton />;
  if (query.isError || query.data === undefined)
    return (
      <EmptyState
        className="m-6"
        icon={<Building />}
        title="Company not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  return (
    <RecordPresenceProvider entity="company" id={id}>
      <CompanyView company={query.data} />
    </RecordPresenceProvider>
  );
}
