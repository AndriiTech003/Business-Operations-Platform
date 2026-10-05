import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CONTACT_STATUSES, type ContactDto, type DealDto, type EmailMessageDto, type InvoiceDto } from '@bop/contracts';
import {
  Avatar,
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
  SkeletonRows,
  toast,
} from '@bop/ui';
import { Ellipsis, FileText, Handshake, Mail, Phone, Play, Trash2, User } from 'lucide-react';
import { api, asList, errorMessage } from '../../lib/api';
import { useCustomFieldsFor } from '../../lib/data';
import { fmtDate, fmtDateTime, money, relative } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { useAuth } from '../../app/auth';
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
import { RelationValue, UserName } from '../../components/FieldValue';
import { useRecord, useRecordUpdate } from '../../components/record/useRecord';
import { InvoiceStatusBadge } from '../invoices/status';
import { CONTACT_STATUS_VARIANT } from './columns';

const route = getRouteApi('/app/contacts/$id');

export function EmailsList({ entity, id }: { entity: 'contact' | 'deal' | 'company' | 'invoice'; id: string }) {
  const query = useQuery({
    queryKey: keys.recordEmails(entity, id),
    queryFn: async () => asList<EmailMessageDto>(await api.get(`/v1/records/${entity}/${id}/emails`)),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" /> Emails
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <SkeletonRows rows={2} />
        ) : (query.data?.length ?? 0) === 0 ? (
          <EmptyState className="py-6" title="No emails" />
        ) : (
          <ul className="divide-y">
            {query.data?.map((m) => (
              <li key={m.id} className="py-2">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 text-left text-sm"
                  onClick={() => setOpenId(openId === m.id ? null : m.id)}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{m.subject}</span>
                  <Badge variant={m.status === 'sent' ? 'success' : m.status === 'failed' ? 'destructive' : 'muted'}>
                    {m.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{relative(m.sentAt ?? m.createdAt)}</span>
                </button>
                {openId === m.id ? (
                  <div className="mt-2 grid gap-1 text-xs">
                    <p className="text-muted-foreground">
                      To {m.to.join(', ')} · {fmtDateTime(m.sentAt ?? m.createdAt)}
                    </p>
                    <iframe
                      title={m.subject}
                      sandbox=""
                      srcDoc={m.html}
                      className="h-64 w-full rounded border bg-white"
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ContactView({ contact }: { contact: ContactDto }) {
  const { can } = useAuth();
  const search = route.useSearch();
  const navigate = useNavigate();
  const defs = useCustomFieldsFor('contact');
  const upd = useRecordUpdate<ContactDto>('contact', contact.id);
  const [runOpen, setRunOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !can('records:write');
  const remove = useMutation({
    mutationFn: () => api.del(`/v1/contacts/${contact.id}`),
    onSuccess: () => {
      toast.success('Contact deleted');
      void navigate({ to: '/contacts' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <RecordLayout
        backTo="/contacts"
        backLabel="Contacts"
        record={{ type: 'contact', id: contact.id, label: contact.name }}
        icon={<Avatar id={contact.id} name={contact.name} size="lg" />}
        title={contact.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-3">
            {contact.title ? <span>{contact.title}</span> : null}
            {contact.company ? (
              <RelationValue entity="company" id={contact.companyId} label={contact.company.name} />
            ) : null}
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 hover:underline">
                <Mail className="size-3" /> {contact.email}
              </a>
            ) : null}
            {contact.phone ? (
              <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1 hover:underline">
                <Phone className="size-3" /> {contact.phone}
              </a>
            ) : null}
          </span>
        }
        badges={<Badge variant={CONTACT_STATUS_VARIANT[contact.status]}>{contact.status}</Badge>}
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
                  <Trash2 /> Delete contact
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        headerFields={
          <>
            <InlineField
              spec={{ key: 'email', label: 'Email', type: 'text' }}
              value={contact.email}
              readOnly={readOnly}
              onSave={(v) => upd.update({ email: v })}
            />
            <InlineField
              spec={{ key: 'status', label: 'Status', type: 'select', options: CONTACT_STATUSES }}
              value={contact.status}
              readOnly={readOnly}
              onSave={(v) => upd.update({ status: v })}
            />
            <InlineField
              spec={{ key: 'companyId', label: 'Company', type: 'relation', relationEntity: 'company' }}
              value={contact.companyId}
              display={<RelationValue entity="company" id={contact.companyId} label={contact.company?.name} />}
              readOnly={readOnly}
              onSave={(v) => upd.update({ companyId: v })}
            />
            <InlineField
              spec={{ key: 'ownerId', label: 'Owner', type: 'user' }}
              value={contact.ownerId}
              display={<UserName id={contact.ownerId} name={contact.owner?.name} />}
              readOnly={readOnly}
              onSave={(v) => upd.update({ ownerId: v })}
            />
          </>
        }
        tab={search.tab}
        onTabChange={(tab) =>
          void navigate({ to: '/contacts/$id', params: { id: contact.id }, search: { tab }, replace: true })
        }
        tabs={[
          {
            value: 'overview',
            label: 'Overview',
            icon: TAB_ICONS.overview,
            content: (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <Card>
                  <CardHeader>
                    <CardTitle>Details</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-1">
                    <InlineField
                      layout="row"
                      spec={{ key: 'firstName', label: 'First name', type: 'text' }}
                      value={contact.firstName}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ firstName: v })}
                    />
                    <InlineField
                      layout="row"
                      spec={{ key: 'lastName', label: 'Last name', type: 'text' }}
                      value={contact.lastName}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ lastName: v ?? '' })}
                    />
                    <InlineField
                      layout="row"
                      spec={{ key: 'title', label: 'Job title', type: 'text' }}
                      value={contact.title}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ title: v })}
                    />
                    <InlineField
                      layout="row"
                      spec={{ key: 'phone', label: 'Phone', type: 'text' }}
                      value={contact.phone}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ phone: v })}
                    />
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Source</span>
                      <span className="px-2">{contact.source ?? '—'}</span>
                    </div>
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Last contacted</span>
                      <span className="px-2">
                        {contact.lastContactedAt ? relative(contact.lastContactedAt) : 'Never'}
                      </span>
                    </div>
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Created</span>
                      <span className="px-2">{fmtDate(contact.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
                <CustomFieldsSection
                  defs={defs}
                  values={contact.custom}
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
            content: <Timeline entity="contact" id={contact.id} />,
          },
          {
            value: 'tasks',
            label: 'Tasks',
            icon: TAB_ICONS.tasks,
            content: <RecordTasks entity="contact" id={contact.id} title={contact.name} />,
          },
          {
            value: 'related',
            label: 'Related',
            icon: TAB_ICONS.related,
            content: (
              <div className="grid gap-4 lg:grid-cols-3">
                <RelatedList<DealDto>
                  title="Deals"
                  icon={<Handshake />}
                  entity="deal"
                  parent={{ entity: 'contact', id: contact.id }}
                  field="contactId"
                  value={contact.id}
                  primary={(d) => d.title}
                  secondary={(d) => d.stage?.name ?? ''}
                  trailing={(d) => <span className="text-sm tabular-nums">{money(d.amountCents, d.currency)}</span>}
                />
                <RelatedList<InvoiceDto>
                  title="Invoices"
                  icon={<FileText />}
                  entity="invoice"
                  parent={{ entity: 'contact', id: contact.id }}
                  field="contactId"
                  value={contact.id}
                  primary={(i) => i.number}
                  secondary={(i) => `Due ${fmtDate(i.dueDate)}`}
                  trailing={(i) => <InvoiceStatusBadge status={i.status} />}
                />
                <EmailsList entity="contact" id={contact.id} />
              </div>
            ),
          },
          {
            value: 'comments',
            label: 'Comments',
            icon: TAB_ICONS.comments,
            content: <Comments entity="contact" id={contact.id} />,
          },
        ]}
      />
      <RunWorkflowDialog entity="contact" id={contact.id} open={runOpen} onOpenChange={setRunOpen} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${contact.name}?`}
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

export function ContactPage() {
  const { id } = route.useParams();
  const query = useRecord<ContactDto>('contact', id);
  if (query.isLoading) return <RecordSkeleton />;
  if (query.isError || query.data === undefined)
    return (
      <EmptyState
        className="m-6"
        icon={<User />}
        title="Contact not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  return (
    <RecordPresenceProvider entity="contact" id={id}>
      <ContactView contact={query.data} />
    </RecordPresenceProvider>
  );
}
