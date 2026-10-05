import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@bop/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { patchListRows, type Versioned } from '../../lib/records';
import { ENTITY_PATH, keys, type RecordEntity } from '../../lib/query-keys';

export function useRecord<T>(entity: RecordEntity, id: string) {
  return useQuery({
    queryKey: keys[entity].detail(id),
    queryFn: ({ signal }) => api.get<T>(`/v1/${ENTITY_PATH[entity]}/${id}`, { signal }),
  });
}

export function mergePatch<T>(row: T, patch: Record<string, unknown>): T {
  const next = { ...(row as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'custom' && v !== null && typeof v === 'object')
      next['custom'] = { ...((next['custom'] as Record<string, unknown>) ?? {}), ...(v as Record<string, unknown>) };
    else next[k] = v;
  }
  return next as T;
}

export interface Conflict<T> {
  mine: Record<string, unknown>;
  current: T;
}

export function useRecordUpdate<T extends Versioned>(entity: RecordEntity, id: string) {
  const qc = useQueryClient();
  const [conflict, setConflict] = useState<Conflict<T> | null>(null);
  const detailKey = keys[entity].detail(id);

  const mutation = useMutation({
    mutationFn: ({ patch, version }: { patch: Record<string, unknown>; version?: number }) =>
      api.patch<T>(`/v1/${ENTITY_PATH[entity]}/${id}`, patch, version === undefined ? undefined : { ifMatch: version }),
    onMutate: async ({ patch }) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<T>(detailKey);
      if (previous !== undefined) qc.setQueryData<T>(detailKey, mergePatch(previous, patch));
      return { previous };
    },
    onError: (error, { patch }, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(detailKey, ctx.previous);
      if (isApiError(error) && error.status === 412) {
        const current = error.problem.current as T | undefined;
        if (current !== undefined && current !== null) {
          setConflict({ mine: patch, current });
          return;
        }
        toast.warning('This record was changed by someone else. Reloaded the latest version.');
        void qc.invalidateQueries({ queryKey: detailKey });
        return;
      }
      toast.error(errorMessage(error));
    },
    onSuccess: (updated) => {
      if (updated !== undefined && updated !== null) {
        qc.setQueryData(detailKey, updated);
        patchListRows<T>(qc, entity, id, () => updated);
      }
      void qc.invalidateQueries({ queryKey: keys[entity].timeline(id) });
    },
  });

  const update = (patch: Record<string, unknown>) => {
    const current = qc.getQueryData<T>(detailKey);
    mutation.mutate({ patch, version: current?.version });
  };

  return {
    update,
    mutation,
    conflict,
    overwrite: () => {
      if (conflict === null) return;
      qc.setQueryData(detailKey, conflict.current);
      mutation.mutate({ patch: conflict.mine, version: conflict.current.version });
      setConflict(null);
    },
    takeTheirs: () => {
      if (conflict === null) return;
      qc.setQueryData(detailKey, conflict.current);
      patchListRows<T>(qc, entity, id, () => conflict.current);
      setConflict(null);
      toast.info('Kept the saved version');
    },
    dismissConflict: () => setConflict(null),
  };
}
