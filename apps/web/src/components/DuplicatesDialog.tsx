import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  SkeletonRows,
  toast,
} from '@bop/ui';
import { CopyCheck, GitMerge } from 'lucide-react';
import { api, asList, errorMessage } from '../lib/api';
import { keys } from '../lib/query-keys';

interface DupRecord {
  id: string;
  name: string;
  domain?: string | null;
  email?: string | null;
}

interface DupGroup {
  key: string;
  records: DupRecord[];
}

function normalize(raw: unknown): DupGroup[] {
  return asList<Record<string, unknown>>(raw).map((g, i) => {
    const records = (g['companies'] ?? g['contacts'] ?? g['records'] ?? g['items'] ?? []) as DupRecord[];
    return { key: typeof g['key'] === 'string' ? g['key'] : String(i), records };
  });
}

function Group({ entity, group, onMerged }: { entity: 'company' | 'contact'; group: DupGroup; onMerged(): void }) {
  const [target, setTarget] = useState(group.records[0]?.id ?? '');
  const merge = useMutation({
    mutationFn: () =>
      api.post(`/v1/${entity === 'company' ? 'companies' : 'contacts'}/merge`, {
        targetId: target,
        sourceIds: group.records.filter((r) => r.id !== target).map((r) => r.id),
      }),
    onSuccess: () => {
      toast.success(`Merged ${group.records.length} records`);
      onMerged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="p-3" data-testid="duplicate-group">
      <div className="mb-2 flex items-center justify-between">
        <Badge variant="secondary">Match: {group.key}</Badge>
        <Button size="xs" onClick={() => merge.mutate()} loading={merge.isPending} data-testid="merge-group">
          <GitMerge /> Merge into selected
        </Button>
      </div>
      <div className="grid gap-1" role="radiogroup" aria-label="Keep record">
        {group.records.map((r) => (
          <label
            key={r.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
          >
            <input
              type="radio"
              name={`target-${group.key}`}
              checked={target === r.id}
              onChange={() => setTarget(r.id)}
            />
            <span className="font-medium">{r.name}</span>
            <span className="text-xs text-muted-foreground">{r.domain ?? r.email ?? ''}</span>
            {target === r.id ? (
              <Badge variant="success" className="ml-auto">
                keep
              </Badge>
            ) : null}
          </label>
        ))}
      </div>
    </Card>
  );
}

export function DuplicatesDialog({
  entity,
  open,
  onOpenChange,
}: {
  entity: 'company' | 'contact';
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.duplicates(entity),
    queryFn: async () => normalize(await api.get(`/v1/${entity === 'company' ? 'companies' : 'contacts'}/duplicates`)),
    enabled: open,
  });
  const groups = (query.data ?? []).filter((g) => g.records.length > 1);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="duplicates-dialog">
        <DialogHeader>
          <DialogTitle>Find duplicates</DialogTitle>
          <DialogDescription>
            Merging moves contacts, deals, invoices, tasks and activity to the record you keep.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <SkeletonRows rows={4} />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<CopyCheck />}
            title="No duplicates found"
            description="Records with the same name, domain or email would appear here."
          />
        ) : (
          <div className="grid gap-3">
            {groups.map((g) => (
              <Group
                key={g.key}
                entity={entity}
                group={g}
                onMerged={() => {
                  void qc.invalidateQueries({ queryKey: keys.duplicates(entity) });
                  void qc.invalidateQueries({ queryKey: keys[entity].lists() });
                }}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
