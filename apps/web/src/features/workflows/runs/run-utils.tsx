import type { RunDetailDto, RunStatus, StepRunDto, StepStatus } from '@bop/contracts';
import { Badge, type BadgeProps } from '@bop/ui';

export const RUN_STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  running: 'info',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'destructive',
  cancelled: 'muted',
  pending: 'info',
  skipped: 'muted',
};

export function StatusBadge({ status }: { status: RunStatus | StepStatus | string }) {
  return (
    <Badge variant={RUN_STATUS_VARIANT[status] ?? 'secondary'} data-testid="run-status" data-status={status}>
      {status}
    </Badge>
  );
}

export function isTerminal(status: RunStatus | string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

const RANK: Record<string, number> = {
  failed: 6,
  running: 5,
  waiting: 4,
  pending: 3,
  succeeded: 2,
  cancelled: 1,
  skipped: 0,
};

export function nodeStatuses(steps: StepRunDto[]): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const s of steps) {
    const prev = out[s.nodeId];
    if (prev === undefined || (RANK[s.status] ?? 0) > (RANK[prev] ?? 0)) out[s.nodeId] = s.status;
  }
  return out;
}

export function traversedSet(run: Pick<RunDetailDto, 'traversedEdges'> | undefined): Set<string> {
  return new Set((run?.traversedEdges ?? []).map((e) => `${e.from}->${e.to}`));
}

export function stepsByNode(steps: StepRunDto[]): Map<string, StepRunDto[]> {
  const map = new Map<string, StepRunDto[]>();
  for (const s of steps)
    map.set(
      s.nodeId,
      [...(map.get(s.nodeId) ?? []), s].sort((a, b) => a.iteration - b.iteration),
    );
  return map;
}
