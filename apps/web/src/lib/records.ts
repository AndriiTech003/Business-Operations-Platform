import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { FilterChip, Page } from '@bop/contracts';
import { toast } from '@bop/ui';
import { api, errorMessage, isApiError } from './api';
import { ENTITY_PATH, keys, type RecordEntity } from './query-keys';
import { listParams, patchFor, setPath, type TableSearch } from './table';

export interface Versioned {
  id: string;
  version?: number;
}

export function useRecordList<T extends Versioned>(
  entity: RecordEntity,
  search: TableSearch,
  opts?: {
    extraFilter?: FilterChip[];
    path?: string;
    pageSize?: number;
    enabled?: boolean;
    refetchInterval?: number | false;
  },
) {
  const params = listParams(search, opts?.extraFilter);
  const path = opts?.path ?? `/v1/${ENTITY_PATH[entity]}`;
  return useInfiniteQuery({
    queryKey: keys[entity].list({ path, ...params }),
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<T>>(path, {
        query: { ...params, limit: opts?.pageSize ?? 50, cursor: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: opts?.enabled ?? true,
    refetchInterval: opts?.refetchInterval,
  });
}

type ListData<T> = InfiniteData<Page<T>, string | null>;

export function patchListRows<T extends Versioned>(
  qc: QueryClient,
  entity: RecordEntity,
  id: string,
  update: (row: T) => T,
): Array<[QueryKey, unknown]> {
  const snapshots = qc.getQueriesData({ queryKey: keys[entity].lists() });
  qc.setQueriesData<ListData<T>>({ queryKey: keys[entity].lists() }, (data) => {
    if (data === undefined || !Array.isArray(data.pages)) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({ ...p, items: p.items.map((r) => (r.id === id ? update(r) : r)) })),
    };
  });
  return snapshots;
}

export function removeListRows(qc: QueryClient, entity: RecordEntity, ids: Set<string>): Array<[QueryKey, unknown]> {
  const snapshots = qc.getQueriesData({ queryKey: keys[entity].lists() });
  qc.setQueriesData<ListData<Versioned>>({ queryKey: keys[entity].lists() }, (data) => {
    if (data === undefined || !Array.isArray(data.pages)) return data;
    return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((r) => !ids.has(r.id)) })) };
  });
  return snapshots;
}

export function restore(qc: QueryClient, snapshots: Array<[QueryKey, unknown]>): void {
  for (const [key, data] of snapshots) qc.setQueryData(key, data);
}

export function useInlineEdit<T extends Versioned>(entity: RecordEntity) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ row, key, value }: { row: T; key: string; value: unknown }) =>
      api.patch<T>(
        `/v1/${ENTITY_PATH[entity]}/${row.id}`,
        patchFor(key, value),
        row.version === undefined ? undefined : { ifMatch: row.version },
      ),
    onMutate: async ({ row, key, value }) => {
      await qc.cancelQueries({ queryKey: keys[entity].lists() });
      const snapshots = patchListRows<T>(qc, entity, row.id, (r) => setPath(r, key, value));
      return { snapshots };
    },
    onSuccess: (updated) => {
      if (updated !== undefined && updated !== null) {
        patchListRows<T>(qc, entity, updated.id, () => updated);
        qc.setQueryData(keys[entity].detail(updated.id), updated);
      }
    },
    onError: (error, _vars, ctx) => {
      if (ctx !== undefined) restore(qc, ctx.snapshots);
      if (isApiError(error) && error.status === 412) {
        toast.warning('Someone else changed this record. Showing the latest version.');
        void qc.invalidateQueries({ queryKey: keys[entity].lists() });
      } else toast.error(errorMessage(error));
    },
  });
}

export function useDeleteRecords(entity: RecordEntity) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.del(`/v1/${ENTITY_PATH[entity]}/${id}`)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) throw new Error(`${failed} of ${ids.length} could not be deleted`);
      return ids.length;
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys[entity].lists() });
      return { snapshots: removeListRows(qc, entity, new Set(ids)) };
    },
    onSuccess: (n) => toast.success(`Deleted ${n} record${n === 1 ? '' : 's'}`),
    onError: (error, _ids, ctx) => {
      if (ctx !== undefined) restore(qc, ctx.snapshots);
      toast.error(errorMessage(error));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys[entity].lists() }),
  });
}
