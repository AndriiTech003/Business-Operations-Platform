import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PipelineDto } from '@bop/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  NativeSelect,
  SkeletonRows,
  toast,
} from '@bop/ui';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { usePipelines } from '../../lib/data';
import { keys } from '../../lib/query-keys';
import { useAuth } from '../../app/auth';

interface StageDraft {
  id?: string;
  name: string;
  probability: number;
  kind: 'open' | 'won' | 'lost';
}

function PipelineEditor({ pipeline, admin }: { pipeline: PipelineDto | null; admin: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState(pipeline?.name ?? 'New pipeline');
  const [stages, setStages] = useState<StageDraft[]>(
    pipeline?.stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability, kind: s.kind })) ?? [
      { name: 'Lead', probability: 10, kind: 'open' },
      { name: 'Won', probability: 100, kind: 'won' },
      { name: 'Lost', probability: 0, kind: 'lost' },
    ],
  );
  const [dirty, setDirty] = useState(pipeline === null);
  useEffect(() => {
    if (pipeline && !dirty) {
      setName(pipeline.name);
      setStages(pipeline.stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability, kind: s.kind })));
    }
  }, [pipeline, dirty]);
  const update = (i: number, patch: Partial<StageDraft>) => {
    setStages(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...stages];
    const [item] = next.splice(i, 1);
    if (item === undefined) return;
    next.splice(i + d, 0, item);
    setStages(next);
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        stages: stages.map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          name: s.name,
          probability: s.probability,
          kind: s.kind,
        })),
      };
      return pipeline
        ? api.put<PipelineDto>(`/v1/pipelines/${pipeline.id}`, body)
        : api.post<PipelineDto>('/v1/pipelines', body);
    },
    onSuccess: () => {
      toast.success('Pipeline saved');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: keys.pipelines });
      void qc.invalidateQueries({ queryKey: keys.deal.all });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid =
    name.trim() !== '' &&
    stages.length > 0 &&
    stages.every((s) => s.name.trim() !== '' && s.probability >= 0 && s.probability <= 100);
  return (
    <Card data-testid="pipeline-editor">
      <CardHeader className="flex-row items-center gap-2">
        <Input
          aria-label="Pipeline name"
          className="h-8 max-w-xs font-semibold"
          value={name}
          disabled={!admin}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        {pipeline?.isDefault ? <Badge variant="secondary">default</Badge> : null}
        <Button
          size="sm"
          className="ml-auto"
          disabled={!admin || !dirty || !valid}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          <Save /> Save
        </Button>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="grid grid-cols-[1fr_110px_110px_auto] gap-2 px-1 text-xs text-muted-foreground">
          <span>Stage</span>
          <span>Probability %</span>
          <span>Kind</span>
          <span />
        </div>
        {stages.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="grid grid-cols-[1fr_110px_110px_auto] items-center gap-2">
            <Input
              aria-label="Stage name"
              className="h-8"
              value={s.name}
              disabled={!admin}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <Input
              aria-label="Probability"
              className="h-8"
              type="number"
              min={0}
              max={100}
              value={s.probability}
              disabled={!admin}
              onChange={(e) => update(i, { probability: Number(e.target.value) })}
            />
            <NativeSelect
              aria-label="Kind"
              className="h-8"
              value={s.kind}
              disabled={!admin}
              onChange={(e) => update(i, { kind: e.target.value as StageDraft['kind'] })}
            >
              <option value="open">open</option>
              <option value="won">won</option>
              <option value="lost">lost</option>
            </NativeSelect>
            <div className="flex">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Move up"
                disabled={!admin || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Move down"
                disabled={!admin || i === stages.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove stage"
                disabled={!admin || stages.length <= 1}
                onClick={() => {
                  setStages(stages.filter((_, j) => j !== i));
                  setDirty(true);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="xs"
          variant="outline"
          className="w-fit"
          disabled={!admin}
          onClick={() => {
            const firstClosed = stages.findIndex((s) => s.kind !== 'open');
            const next = [...stages];
            next.splice(firstClosed < 0 ? next.length : firstClosed, 0, {
              name: 'New stage',
              probability: 50,
              kind: 'open',
            });
            setStages(next);
            setDirty(true);
          }}
        >
          <Plus /> Add stage
        </Button>
        <p className="text-xs text-muted-foreground">
          Moving a deal into a “lost” stage asks for a reason. Removing a stage that still has deals is rejected by the
          server.
        </p>
      </CardContent>
    </Card>
  );
}

export function PipelinesSettings() {
  const { can } = useAuth();
  const { data, isLoading } = usePipelines();
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Pipelines & stages</CardTitle>
            <CardDescription>
              Stages become the columns of the deals board. Probability drives the weighted forecast.
            </CardDescription>
          </div>
          <Button size="sm" disabled={!can('admin') || adding} onClick={() => setAdding(true)}>
            <Plus /> New pipeline
          </Button>
        </CardHeader>
      </Card>
      {isLoading ? <SkeletonRows rows={4} /> : null}
      {data?.map((p) => (
        <PipelineEditor key={p.id} pipeline={p} admin={can('admin')} />
      ))}
      {adding ? <PipelineEditor pipeline={null} admin={can('admin')} /> : null}
    </div>
  );
}
