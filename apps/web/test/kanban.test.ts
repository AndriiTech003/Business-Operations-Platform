import { describe, expect, it } from 'vitest';
import type { DealDto, StageDto } from '@bop/contracts';
import {
  applyMove,
  buildColumns,
  columnTotals,
  moveBetween,
  neighbours,
  planMove,
} from '../src/features/deals/kanban-utils';

const stages: StageDto[] = [
  { id: 's1', name: 'Lead', position: 0, probability: 10, kind: 'open' },
  { id: 's2', name: 'Won', position: 1, probability: 100, kind: 'won' },
];

function deal(id: string, stageId: string, position: number, amountCents = 1000): DealDto {
  return {
    id,
    title: id,
    pipelineId: 'p',
    stageId,
    stage: null,
    companyId: null,
    company: null,
    contactId: null,
    contact: null,
    amountCents,
    currency: 'USD',
    expectedCloseAt: null,
    ownerId: null,
    owner: null,
    position,
    custom: {},
    tags: [],
    stageChangedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    lostReason: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const deals = [
  deal('a', 's1', 1024),
  deal('b', 's1', 2048),
  deal('c', 's1', 3072),
  deal('x', 's2', 1024),
  deal('y', 's2', 2048),
];

describe('kanban fractional neighbours', () => {
  it('orders columns by position', () => {
    expect(buildColumns(stages, [...deals].reverse())).toEqual({ s1: ['a', 'b', 'c'], s2: ['x', 'y'] });
  });

  it('beforeId is the card above and afterId the card below', () => {
    expect(neighbours(['a', 'b', 'c'], 'b')).toEqual({ beforeId: 'a', afterId: 'c' });
    expect(neighbours(['a', 'b', 'c'], 'a')).toEqual({ beforeId: null, afterId: 'b' });
    expect(neighbours(['a', 'b', 'c'], 'c')).toEqual({ beforeId: 'b', afterId: null });
  });

  it('plans a move into the middle of another column with a fractional position', () => {
    const cols = moveBetween(buildColumns(stages, deals), 'b', 's2', 1);
    expect(cols).toEqual({ s1: ['a', 'c'], s2: ['x', 'b', 'y'] });
    expect(planMove(cols, deals, 'b')).toEqual({
      dealId: 'b',
      stageId: 's2',
      beforeId: 'x',
      afterId: 'y',
      position: 1536,
    });
  });

  it('plans moves to the top, bottom and an empty column', () => {
    const top = moveBetween(buildColumns(stages, deals), 'c', 's1', 0);
    expect(planMove(top, deals, 'c')).toMatchObject({ beforeId: null, afterId: 'a', position: 0 });
    const bottom = moveBetween(buildColumns(stages, deals), 'a', 's2', 99);
    expect(planMove(bottom, deals, 'a')).toMatchObject({ stageId: 's2', beforeId: 'y', afterId: null, position: 3072 });
    const emptyStages = [...stages, { id: 's3', name: 'Lost', position: 2, probability: 0, kind: 'lost' as const }];
    const empty = moveBetween(buildColumns(emptyStages, deals), 'a', 's3', 0);
    expect(planMove(empty, deals, 'a')).toMatchObject({ stageId: 's3', beforeId: null, afterId: null, position: 1024 });
  });

  it('applies an optimistic move and computes weighted column totals', () => {
    const board = { pipeline: { id: 'p', name: 'Sales', isDefault: true, stages }, deals };
    const plan = planMove(moveBetween(buildColumns(stages, deals), 'b', 's2', 1), deals, 'b');
    if (plan === null) throw new Error('no plan');
    const next = applyMove(board, plan);
    const moved = next.deals.find((d) => d.id === 'b');
    expect(moved?.stageId).toBe('s2');
    expect(moved?.position).toBe(1536);
    expect(columnTotals(next.deals, stages[0] as StageDto)).toEqual({ count: 2, totalCents: 2000, weightedCents: 200 });
    expect(columnTotals(next.deals, stages[1] as StageDto)).toEqual({
      count: 3,
      totalCents: 3000,
      weightedCents: 3000,
    });
  });
});
