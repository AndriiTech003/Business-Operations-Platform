import { Avatar, Badge } from '@bop/ui';
import { Link } from '@tanstack/react-router';
import { useMemberMap } from '../lib/data';
import { fmtDate, money } from '../lib/format';
import type { RecordEntity } from '../lib/query-keys';
import type { FieldSpec } from '../lib/table';
import { useRecordTitle } from './pickers';
import { recordHref } from './record-links';

export function UserName({ id, name }: { id: string | null | undefined; name?: string | null }) {
  const members = useMemberMap();
  if (!id) return <span className="text-muted-foreground">—</span>;
  const label = name ?? members.get(id)?.name ?? 'Unknown user';
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar id={id} name={label} size="xs" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function RelationValue({
  entity,
  id,
  label,
}: {
  entity: RecordEntity;
  id: string | null | undefined;
  label?: string | null;
}) {
  const title = useRecordTitle(entity, id, label);
  if (!id) return <span className="text-muted-foreground">—</span>;
  return (
    <Link
      {...recordHref(entity, id)}
      className="truncate text-primary hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {label ?? title.data ?? '…'}
    </Link>
  );
}

export function FieldValue({
  spec,
  value,
  currency,
}: {
  spec: Pick<FieldSpec, 'type' | 'relationEntity' | 'currency'>;
  value: unknown;
  currency?: string;
}) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-muted-foreground">—</span>;
  }
  switch (spec.type) {
    case 'money':
      return <span className="tabular-nums">{money(Number(value), currency ?? spec.currency ?? 'USD')}</span>;
    case 'number':
      return <span className="tabular-nums">{Number(value).toLocaleString('en-US')}</span>;
    case 'date':
      return <span>{fmtDate(String(value))}</span>;
    case 'select':
      return <Badge variant="secondary">{String(value)}</Badge>;
    case 'multi_select':
      return (
        <span className="flex flex-wrap gap-1">
          {(Array.isArray(value) ? value : [value]).map((v) => (
            <Badge key={String(v)} variant="secondary">
              {String(v)}
            </Badge>
          ))}
        </span>
      );
    case 'user':
      return <UserName id={String(value)} />;
    case 'relation':
      return <RelationValue entity={(spec.relationEntity ?? 'company') as RecordEntity} id={String(value)} />;
    case 'bool':
      return <span>{value === true ? 'Yes' : 'No'}</span>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}
