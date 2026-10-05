import type { DealDto } from '@bop/contracts';
import { Badge } from '@bop/ui';
import type { ColumnSpec } from '../../components/data-table/DataTable';
import { RelationValue, UserName } from '../../components/FieldValue';
import { daysSince } from '../../lib/format';

export function dealColumns(stageOptions: Array<{ id: string; name: string }>): ColumnSpec<DealDto>[] {
  return [
    {
      key: 'title',
      label: 'Title',
      type: 'text',
      editable: true,
      width: 240,
      render: (r) => <span className="font-medium">{r.title}</span>,
    },
    {
      key: 'stageId',
      label: 'Stage',
      type: 'select',
      options: stageOptions.map((s) => s.id),
      optionLabels: Object.fromEntries(stageOptions.map((s) => [s.id, s.name])),
      width: 140,
      render: (r) => (
        <Badge variant={r.stage?.kind === 'won' ? 'success' : r.stage?.kind === 'lost' ? 'destructive' : 'secondary'}>
          {r.stage?.name ?? '—'}
        </Badge>
      ),
    },
    { key: 'amountCents', label: 'Amount', type: 'money', editable: true, width: 140 },
    {
      key: 'companyId',
      label: 'Company',
      type: 'relation',
      relationEntity: 'company',
      width: 180,
      render: (r) => <RelationValue entity="company" id={r.companyId} label={r.company?.name} />,
    },
    {
      key: 'contactId',
      label: 'Contact',
      type: 'relation',
      relationEntity: 'contact',
      width: 160,
      render: (r) => <RelationValue entity="contact" id={r.contactId} label={r.contact?.name} />,
    },
    {
      key: 'ownerId',
      label: 'Owner',
      type: 'user',
      editable: true,
      width: 160,
      render: (r) => <UserName id={r.ownerId} name={r.owner?.name} />,
    },
    { key: 'expectedCloseAt', label: 'Expected close', type: 'date', editable: true, width: 140 },
    {
      key: 'stageChangedAt',
      label: 'In stage',
      type: 'date',
      width: 110,
      render: (r) => <span className="tabular-nums">{daysSince(r.stageChangedAt)}d</span>,
    },
    { key: 'lostReason', label: 'Lost reason', type: 'text', width: 180 },
    { key: 'createdAt', label: 'Created', type: 'date', width: 120 },
  ];
}

export const DEAL_DEFAULT_COLUMNS = [
  'title',
  'stageId',
  'amountCents',
  'companyId',
  'ownerId',
  'expectedCloseAt',
  'stageChangedAt',
];
