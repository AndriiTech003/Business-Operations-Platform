import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { DealDto, InvoiceDto } from '@bop/contracts';
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
import { Ellipsis, FileText, Handshake, Play, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCustomFieldsFor, usePipelines } from '../../lib/data';
import { daysSince, fmtDate, money } from '../../lib/format';
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
import { EmailsList } from '../contacts/ContactPage';
import { LostReasonDialog } from './LostReasonDialog';

const route = getRouteApi('/app/deals/$id');

function DealView({ deal }: { deal: DealDto }) {
  const { can } = useAuth();
  const search = route.useSearch();
  const navigate = useNavigate();
  const defs = useCustomFieldsFor('deal');
  const { data: pipelines } = usePipelines();
  const stages = pipelines?.find((p) => p.id === deal.pipelineId)?.stages ?? [];
  const upd = useRecordUpdate<DealDto>('deal', deal.id);
  const [runOpen, setRunOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lostStage, setLostStage] = useState<string | null>(null);
  const readOnly = !can('records:write');
  const remove = useMutation({
    mutationFn: () => api.del(`/v1/deals/${deal.id}`),
    onSuccess: () => {
      toast.success('Deal deleted');
      void navigate({ to: '/deals' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const kind = deal.stage?.kind ?? 'open';

  return (
    <>
      <RecordLayout
        backTo="/deals"
        backLabel="Deals"
        record={{ type: 'deal', id: deal.id, label: deal.title }}
        icon={<Handshake />}
        title={deal.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-3">
            <RelationValue entity="company" id={deal.companyId} label={deal.company?.name} />
            <span>{daysSince(deal.stageChangedAt)} days in stage</span>
          </span>
        }
        badges={
          <>
            <Badge
              variant={kind === 'won' ? 'success' : kind === 'lost' ? 'destructive' : 'default'}
              data-testid="deal-stage"
            >
              {deal.stage?.name ?? 'Unknown stage'}
            </Badge>
            <span className="text-lg font-semibold tabular-nums text-muted-foreground">
              {money(deal.amountCents, deal.currency)}
            </span>
          </>
        }
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
                  <Trash2 /> Delete deal
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        headerFields={
          <>
            <InlineField
              spec={{ key: 'amountCents', label: 'Amount', type: 'money' }}
              value={deal.amountCents}
              currency={deal.currency}
              readOnly={readOnly}
              onSave={(v) => upd.update({ amountCents: v ?? 0 })}
            />
            <InlineField
              spec={{
                key: 'stageId',
                label: 'Stage',
                type: 'select',
                options: stages.map((s) => s.id),
                optionLabels: Object.fromEntries(stages.map((s) => [s.id, s.name])),
              }}
              value={deal.stageId}
              display={deal.stage?.name}
              readOnly={readOnly}
              onSave={(v) => {
                if (typeof v !== 'string') return;
                if (stages.find((s) => s.id === v)?.kind === 'lost') setLostStage(v);
                else upd.update({ stageId: v });
              }}
            />
            <InlineField
              spec={{ key: 'ownerId', label: 'Owner', type: 'user' }}
              value={deal.ownerId}
              display={<UserName id={deal.ownerId} name={deal.owner?.name} />}
              readOnly={readOnly}
              onSave={(v) => upd.update({ ownerId: v })}
            />
            <InlineField
              spec={{ key: 'expectedCloseAt', label: 'Expected close', type: 'date' }}
              value={deal.expectedCloseAt}
              readOnly={readOnly}
              onSave={(v) => upd.update({ expectedCloseAt: v })}
            />
          </>
        }
        tab={search.tab}
        onTabChange={(tab) =>
          void navigate({ to: '/deals/$id', params: { id: deal.id }, search: { tab }, replace: true })
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
                      spec={{ key: 'title', label: 'Title', type: 'text' }}
                      value={deal.title}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ title: v })}
                    />
                    <InlineField
                      layout="row"
                      spec={{ key: 'companyId', label: 'Company', type: 'relation', relationEntity: 'company' }}
                      value={deal.companyId}
                      display={<RelationValue entity="company" id={deal.companyId} label={deal.company?.name} />}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ companyId: v })}
                    />
                    <InlineField
                      layout="row"
                      spec={{ key: 'contactId', label: 'Contact', type: 'relation', relationEntity: 'contact' }}
                      value={deal.contactId}
                      display={<RelationValue entity="contact" id={deal.contactId} label={deal.contact?.name} />}
                      readOnly={readOnly}
                      onSave={(v) => upd.update({ contactId: v })}
                    />
                    {kind === 'lost' ? (
                      <InlineField
                        layout="row"
                        spec={{ key: 'lostReason', label: 'Lost reason', type: 'text' }}
                        value={deal.lostReason}
                        readOnly={readOnly}
                        onSave={(v) => upd.update({ lostReason: v })}
                      />
                    ) : null}
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Stage changed</span>
                      <span className="px-2">{fmtDate(deal.stageChangedAt)}</span>
                    </div>
                    {deal.closedAt ? (
                      <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">Closed</span>
                        <span className="px-2">{fmtDate(deal.closedAt)}</span>
                      </div>
                    ) : null}
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2 py-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Created</span>
                      <span className="px-2">{fmtDate(deal.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
                <CustomFieldsSection
                  defs={defs}
                  values={deal.custom}
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
            content: <Timeline entity="deal" id={deal.id} />,
          },
          {
            value: 'tasks',
            label: 'Tasks',
            icon: TAB_ICONS.tasks,
            content: <RecordTasks entity="deal" id={deal.id} title={deal.title} />,
          },
          {
            value: 'related',
            label: 'Related',
            icon: TAB_ICONS.related,
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <RelatedList<InvoiceDto>
                  title="Invoices"
                  icon={<FileText />}
                  entity="invoice"
                  parent={{ entity: 'deal', id: deal.id }}
                  field="dealId"
                  value={deal.id}
                  primary={(i) => i.number}
                  secondary={(i) => `Due ${fmtDate(i.dueDate)} · ${money(i.totalCents, i.currency)}`}
                  trailing={(i) => <InvoiceStatusBadge status={i.status} />}
                />
                <EmailsList entity="deal" id={deal.id} />
              </div>
            ),
          },
          {
            value: 'comments',
            label: 'Comments',
            icon: TAB_ICONS.comments,
            content: <Comments entity="deal" id={deal.id} />,
          },
        ]}
      />
      <RunWorkflowDialog entity="deal" id={deal.id} open={runOpen} onOpenChange={setRunOpen} />
      <LostReasonDialog
        open={lostStage !== null}
        dealTitle={deal.title}
        onCancel={() => setLostStage(null)}
        onConfirm={(reason) => {
          if (lostStage !== null) upd.update({ stageId: lostStage, lostReason: reason });
          setLostStage(null);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${deal.title}?`}
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

export function DealPage() {
  const { id } = route.useParams();
  const query = useRecord<DealDto>('deal', id);
  if (query.isLoading) return <RecordSkeleton />;
  if (query.isError || query.data === undefined)
    return (
      <EmptyState
        className="m-6"
        icon={<Handshake />}
        title="Deal not found"
        description={query.error ? errorMessage(query.error) : undefined}
      />
    );
  return (
    <RecordPresenceProvider entity="deal" id={id}>
      <DealView deal={query.data} />
    </RecordPresenceProvider>
  );
}
