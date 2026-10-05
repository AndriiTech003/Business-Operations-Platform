import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Page } from '@bop/contracts';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, SkeletonRows } from '@bop/ui';
import { api } from '../../lib/api';
import { ENTITY_PATH, keys, type RecordEntity } from '../../lib/query-keys';
import { filterParam } from '../../lib/table';
import { recordHref } from '../record-links';

export function RelatedList<T extends { id: string }>({
  title,
  entity,
  parent,
  field,
  value,
  primary,
  secondary,
  trailing,
  action,
  icon,
}: {
  title: string;
  entity: RecordEntity;
  parent: { entity: RecordEntity; id: string };
  field: string;
  value: string;
  primary(row: T): ReactNode;
  secondary?(row: T): ReactNode;
  trailing?(row: T): ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  const query = useQuery({
    queryKey: keys.related(parent.entity, parent.id, `${entity}:${field}`),
    queryFn: () =>
      api.get<Page<T>>(`/v1/${ENTITY_PATH[entity]}`, {
        query: { limit: 50, filter: filterParam([{ field, op: 'eq', value }]) },
      }),
  });
  const items = query.data?.items ?? [];
  return (
    <Card data-testid={`related-${entity}`}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {icon}
          {title}
          <span className="font-normal text-muted-foreground">{query.data ? items.length : ''}</span>
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <SkeletonRows rows={3} />
        ) : items.length === 0 ? (
          <EmptyState className="py-6" title={`No ${title.toLowerCase()}`} />
        ) : (
          <ul className="divide-y">
            {items.map((r) => (
              <li key={r.id}>
                <Link
                  {...recordHref(entity, r.id)}
                  className="flex items-center gap-3 rounded-md px-1 py-2 text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{primary(r)}</span>
                    {secondary ? (
                      <span className="block truncate text-xs text-muted-foreground">{secondary(r)}</span>
                    ) : null}
                  </span>
                  {trailing ? <span className="shrink-0">{trailing(r)}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
