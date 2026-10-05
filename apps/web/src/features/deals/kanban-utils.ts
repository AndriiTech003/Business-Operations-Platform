import { fractionalPosition, type DealDto, type StageDto } from '@bop/contracts';

export type Columns = Record<string, string[]>;

export interface BoardData {
  pipeline: { id: string; name: string; isDefault: boolean; stages: StageDto[] };
  deals: DealDto[];
}

export function buildColumns(stages: StageDto[], deals: DealDto[]): Columns {
  const cols: Columns = {};
  for (const s of stages) cols[s.id] = [];
  const sorted = [...deals].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const d of sorted) cols[d.stageId]?.push(d.id);
  return cols;
}

export function findColumn(cols: Columns, id: string): string | null {
  if (id in cols) return id;
  for (const [stageId, ids] of Object.entries(cols)) if (ids.includes(id)) return stageId;
  return null;
}

export function moveBetween(cols: Columns, dealId: string, toStageId: string, toIndex: number): Columns {
  const from = findColumn(cols, dealId);
  if (from === null || !(toStageId in cols)) return cols;
  const next: Columns = { ...cols };
  next[from] = (next[from] ?? []).filter((id) => id !== dealId);
  const target = [...(next[toStageId] ?? [])].filter((id) => id !== dealId);
  const index = Math.max(0, Math.min(toIndex, target.length));
  target.splice(index, 0, dealId);
  next[toStageId] = target;
  return next;
}

export function neighbours(ids: string[], dealId: string): { beforeId: string | null; afterId: string | null } {
  const i = ids.indexOf(dealId);
  if (i < 0) return { beforeId: null, afterId: null };
  return { beforeId: ids[i - 1] ?? null, afterId: ids[i + 1] ?? null };
}

export interface MovePlan {
  dealId: string;
  stageId: string;
  beforeId: string | null;
  afterId: string | null;
  position: number;
}

export function planMove(cols: Columns, deals: DealDto[], dealId: string): MovePlan | null {
  const stageId = findColumn(cols, dealId);
  if (stageId === null) return null;
  const ids = cols[stageId] ?? [];
  const { beforeId, afterId } = neighbours(ids, dealId);
  const byId = new Map(deals.map((d) => [d.id, d]));
  const before = beforeId === null ? null : (byId.get(beforeId)?.position ?? null);
  const after = afterId === null ? null : (byId.get(afterId)?.position ?? null);
  return { dealId, stageId, beforeId, afterId, position: fractionalPosition(before, after) };
}

export function applyMove(board: BoardData, plan: MovePlan, lostReason?: string | null): BoardData {
  const stage = board.pipeline.stages.find((s) => s.id === plan.stageId) ?? null;
  return {
    ...board,
    deals: board.deals.map((d) =>
      d.id === plan.dealId
        ? {
            ...d,
            stageId: plan.stageId,
            stage,
            position: plan.position,
            stageChangedAt: d.stageId === plan.stageId ? d.stageChangedAt : new Date().toISOString(),
            lostReason: lostReason ?? d.lostReason,
          }
        : d,
    ),
  };
}

export function columnTotals(
  deals: DealDto[],
  stage: StageDto,
): { count: number; totalCents: number; weightedCents: number } {
  const inStage = deals.filter((d) => d.stageId === stage.id);
  const totalCents = inStage.reduce((s, d) => s + d.amountCents, 0);
  return { count: inStage.length, totalCents, weightedCents: Math.round((totalCents * stage.probability) / 100) };
}

export function sameOrder(a: Columns, b: Columns): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a[k] ?? []).join() === (b[k] ?? []).join());
}

export function adjacentColumn(
  order: string[],
  cols: Columns,
  fromId: string | null,
  activeId: string,
  direction: 1 | -1,
): string | null {
  const current = (fromId === null ? null : findColumn(cols, fromId)) ?? findColumn(cols, activeId);
  if (current === null) return null;
  const index = order.indexOf(current);
  if (index < 0) return null;
  return order[index + direction] ?? null;
}

export function nextKeyboardColumn(
  order: string[],
  cols: Columns,
  lastTarget: string | null,
  overId: string | null,
  activeId: string,
  direction: 1 | -1,
): string | null {
  return adjacentColumn(order, cols, lastTarget ?? overId, activeId, direction);
}
