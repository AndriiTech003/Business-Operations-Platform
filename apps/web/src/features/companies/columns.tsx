import type { CompanyDto } from '@bop/contracts';
import type { ColumnSpec } from '../../components/data-table/DataTable';
import { UserName } from '../../components/FieldValue';

export const COMPANY_COLUMNS: ColumnSpec<CompanyDto>[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'text',
    editable: true,
    width: 220,
    render: (r) => <span className="font-medium">{r.name}</span>,
  },
  { key: 'domain', label: 'Domain', type: 'text', editable: true, width: 180 },
  { key: 'industry', label: 'Industry', type: 'text', editable: true, width: 150 },
  { key: 'size', label: 'Employees', type: 'number', editable: true, width: 110 },
  {
    key: 'ownerId',
    label: 'Owner',
    type: 'user',
    editable: true,
    width: 170,
    render: (r) => <UserName id={r.ownerId} name={r.owner?.name} />,
  },
  { key: 'createdAt', label: 'Created', type: 'date', width: 130 },
  { key: 'updatedAt', label: 'Updated', type: 'date', width: 130 },
];

export const COMPANY_DEFAULT_COLUMNS = ['name', 'domain', 'industry', 'size', 'ownerId', 'createdAt'];
