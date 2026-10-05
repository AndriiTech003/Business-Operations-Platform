import { CONTACT_STATUSES, type ContactDto } from '@bop/contracts';
import { Badge } from '@bop/ui';
import type { ColumnSpec } from '../../components/data-table/DataTable';
import { RelationValue, UserName } from '../../components/FieldValue';

export const CONTACT_STATUS_VARIANT = {
  lead: 'info',
  active: 'default',
  customer: 'success',
  churned: 'muted',
} as const;

export const CONTACT_COLUMNS: ColumnSpec<ContactDto>[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'text',
    width: 200,
    sortable: true,
    filterable: true,
    render: (r) => <span className="font-medium">{r.name}</span>,
  },
  { key: 'firstName', label: 'First name', type: 'text', editable: true, width: 140 },
  { key: 'lastName', label: 'Last name', type: 'text', editable: true, width: 140 },
  { key: 'email', label: 'Email', type: 'text', editable: true, width: 220 },
  { key: 'phone', label: 'Phone', type: 'text', editable: true, width: 150 },
  { key: 'title', label: 'Job title', type: 'text', editable: true, width: 160 },
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: CONTACT_STATUSES,
    editable: true,
    width: 120,
    render: (r) => <Badge variant={CONTACT_STATUS_VARIANT[r.status]}>{r.status}</Badge>,
  },
  {
    key: 'companyId',
    label: 'Company',
    type: 'relation',
    relationEntity: 'company',
    width: 180,
    render: (r) => <RelationValue entity="company" id={r.companyId} label={r.company?.name} />,
  },
  {
    key: 'ownerId',
    label: 'Owner',
    type: 'user',
    editable: true,
    width: 160,
    render: (r) => <UserName id={r.ownerId} name={r.owner?.name} />,
  },
  { key: 'source', label: 'Source', type: 'text', width: 120 },
  { key: 'lastContactedAt', label: 'Last contacted', type: 'date', width: 140 },
  { key: 'createdAt', label: 'Created', type: 'date', width: 130 },
];

export const CONTACT_DEFAULT_COLUMNS = ['name', 'email', 'title', 'status', 'companyId', 'ownerId', 'lastContactedAt'];
