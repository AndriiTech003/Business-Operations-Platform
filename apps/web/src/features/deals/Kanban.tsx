import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Announcements,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DealDto, StageDto } from '@bop/contracts';
import { Avatar, Badge, Button, EmptyState, Skeleton, Tooltip, cn, toast } from '@bop/ui';
import { CalendarClock, Plus, RefreshCw, TriangleAlert, Trophy, CircleX } from 'lucide-react';
import { useMe } from '../../app/auth';
import { api, errorMessage, isApiError } from '../../lib/api';
import { compactMoney, daysSince, fmtDate } from '../../lib/format';
import { keys } from '../../lib/query-keys';
import { channels, useChannel, usePollInterval } from '../../lib/realtime';
import {
  nextKeyboardColumn,
  applyMove,
  buildColumns,
  columnTotals,
  findColumn,
  moveBetween,
  planMove,
  sameOrder,
  type BoardData,
  type Columns,
  type MovePlan,
} from './kanban-utils';
import { LostReasonDialog } from './LostReasonDialog';

const DealCard = memo(function DealCard({
  deal,
  flash,
  overlay,
  onOpen,
}: {
  deal: DealDto;
  flash?: boolean;
  overlay?: boolean;
  onOpen?(): void;
}) {
  const days = daysSince(deal.stageChangedAt);
  return (
    <div
      className={cn(
        'group grid gap-2 rounded-lg border bg-card p-3 text-left shadow-xs transition-shadow hover:shadow-md',
        overlay && 'rotate-1 shadow-xl ring-2 ring-primary/40',
        flash && 'animate-flash',
      )}
      data-testid={overlay ? undefined : `deal-card-${deal.id}`}
      data-deal-title={deal.title}
      data-stage-id={deal.stageId}
      onDoubleClick={onOpen}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer text-left text-sm font-medium leading-snug hover:underline"
          onClick={onOpen}
        >
          {deal.title}
        </button>
        {deal.owner ? <Avatar id={deal.owner.id} name={deal.owner.name} size="xs" /> : null}
      </div>
      {deal.company ? <p className="truncate text-xs text-muted-foreground">{deal.company.name}</p> : null}
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold tabular-nums">{compactMoney(deal.amountCents, deal.currency)}</span>
        {deal.expectedCloseAt ? (
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            <CalendarClock className="size-3" />
            {fmtDate(deal.expectedCloseAt, 'MMM d')}
          </span>
        ) : null}
        <Tooltip content={`In this stage since ${fmtDate(deal.stageChangedAt)}`}>
          <span
            className={cn(
              'ml-auto rounded px-1.5 py-0.5 tabular-nums',
              days > 14 ? 'bg-warning/20 text-[oklch(0.5_0.12_70)]' : 'bg-muted text-muted-foreground',
            )}
          >
            {days}d
          </span>
        </Tooltip>
      </div>
    </div>
  );
});

function SortableDeal({ deal, flash, onOpen }: { deal: DealDto; flash: boolean; onOpen(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    data: { type: 'deal' },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'cursor-grab touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
      aria-label={`${deal.title}, ${compactMoney(deal.amountCents, deal.currency)}. Press space to pick up.`}
      {...attributes}
      aria-roledescription="Draggable deal"
      {...listeners}
    >
      <DealCard deal={deal} flash={flash} onOpen={onOpen} />
    </div>
  );
}

function Column({
  stage,
  ids,
  dealsById,
  flash,
  currency,
  onOpen,
  onCreate,
}: {
  stage: StageDto;
  ids: string[];
  dealsById: Map<string, DealDto>;
  flash: Set<string>;
  currency: string;
  onOpen(id: string): void;
  onCreate(stageId: string): void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { type: 'column' } });
  const colDeals = ids.map((id) => dealsById.get(id)).filter((d): d is DealDto => d !== undefined);
  const totals = columnTotals(
    colDeals.map((d) => ({ ...d, stageId: stage.id })),
    stage,
  );
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name} stage`}
      data-testid={`kanban-column-${stage.name}`}
      data-stage-id={stage.id}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors',
        isOver && 'border-primary/50 bg-accent/60',
      )}
    >
      <header className="grid gap-1 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          {stage.kind === 'won' ? (
            <Trophy className="size-3.5 text-success" />
          ) : stage.kind === 'lost' ? (
            <CircleX className="size-3.5 text-destructive" />
          ) : null}
          <h2 className="text-sm font-semibold">{stage.name}</h2>
          <Badge variant="muted" className="px-1.5" data-testid="column-count">
            {totals.count}
          </Badge>
          <span className="ml-auto text-[11px] text-muted-foreground">{stage.probability}%</span>
          <button
            type="button"
            aria-label={`Add deal to ${stage.name}`}
            onClick={() => onCreate(stage.id)}
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-background"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums" data-testid="column-sum">
            {compactMoney(totals.totalCents, currency)}
          </span>
          <Tooltip content="Weighted by stage probability">
            <span className="tabular-nums" data-testid="column-weighted">
              {compactMoney(totals.weightedCents, currency)} wtd
            </span>
          </Tooltip>
        </div>
      </header>
      <SortableContext id={stage.id} items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {colDeals.map((d) => (
            <SortableDeal key={d.id} deal={d} flash={flash.has(d.id)} onOpen={() => onOpen(d.id)} />
          ))}
          {colDeals.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              Drop deals here
            </p>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}

export function Kanban({ pipelineId, onCreate }: { pipelineId: string | undefined; onCreate(stageId: string): void }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const boardKey = keys.deal.board(pipelineId);
  const interval = usePollInterval(5000);
  const query = useQuery({
    queryKey: boardKey,
    queryFn: ({ signal }) => api.get<BoardData>('/v1/deals/board', { query: { pipelineId }, signal }),
    refetchInterval: interval,
  });
  const board = query.data;
  const stages = useMemo(() => [...(board?.pipeline.stages ?? [])].sort((a, b) => a.position - b.position), [board]);
  const serverColumns = useMemo(() => buildColumns(stages, board?.deals ?? []), [stages, board]);
  const [columns, setColumns] = useState<Columns>(serverColumns);
  const [activeId, setActiveId] = useState<string | null>(null);
  const origin = useRef<{ stageId: string; columns: Columns } | null>(null);
  const [pendingLost, setPendingLost] = useState<{ plan: MovePlan; revert: Columns } | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeId === null && pendingLost === null)
      setColumns((prev) => (sameOrder(prev, serverColumns) ? prev : serverColumns));
  }, [serverColumns, activeId, pendingLost]);

  const flashDeal = (id: string) => {
    setFlash((s) => new Set(s).add(id));
    setTimeout(
      () =>
        setFlash((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      1700,
    );
  };

  useChannel(channels.deals(me.tenant.id), {
    onMessage: (d) => {
      const actor = (d['actor'] ?? null) as { id?: string | null } | null;
      const dealId = typeof d['dealId'] === 'string' ? d['dealId'] : null;
      if (actor?.id === me.user.id && d['type'] !== 'deal.created') return;
      void qc.invalidateQueries({ queryKey: keys.deal.all }).then(() => {
        if (dealId !== null && d['type'] !== 'deal.deleted') flashDeal(dealId);
      });
    },
  });

  const move = useMutation({
    mutationFn: ({
      plan,
      version,
      lostReason,
    }: {
      plan: MovePlan;
      version: number;
      lostReason?: string;
      previous: BoardData | undefined;
    }) =>
      api.patch<DealDto>(
        `/v1/deals/${plan.dealId}/move`,
        {
          stageId: plan.stageId,
          beforeId: plan.beforeId,
          afterId: plan.afterId,
          ...(lostReason ? { lostReason } : {}),
        },
        { ifMatch: version },
      ),
    onMutate: ({ previous }) => ({ previous }),
    onError: (e, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(boardKey, ctx.previous);
      if (ctx?.previous !== undefined) setColumns(buildColumns(stages, ctx.previous.deals));
      toast.error(
        isApiError(e) && e.status === 412
          ? 'This deal was changed by someone else. The board was refreshed.'
          : `Move failed: ${errorMessage(e)}`,
      );
      void qc.invalidateQueries({ queryKey: boardKey });
    },
    onSuccess: (deal) => {
      qc.setQueryData<BoardData>(boardKey, (old) =>
        old === undefined ? old : { ...old, deals: old.deals.map((d) => (d.id === deal.id ? deal : d)) },
      );
      qc.setQueryData(keys.deal.detail(deal.id), deal);
      void qc.invalidateQueries({ queryKey: keys.deal.lists() });
      void qc.invalidateQueries({ queryKey: keys.deal.forecast(pipelineId) });
      if (deal.stage?.kind === 'won') toast.success(`🎉 ${deal.title} won`);
    },
  });

  const columnsRef = useRef(columns);
  const keyboardTarget = useRef<string | null>(null);
  const orderRef = useRef<string[]>([]);
  useEffect(() => {
    columnsRef.current = columns;
    orderRef.current = stages.map((s) => s.id);
  }, [columns, stages]);
  const coordinateGetter = useMemo<KeyboardCoordinateGetter>(
    () => (event, args) => {
      if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') return sortableKeyboardCoordinates(event, args);
      event.preventDefault();
      const overId = args.context.over === null ? null : String(args.context.over.id);
      const target = nextKeyboardColumn(
        orderRef.current,
        columnsRef.current,
        keyboardTarget.current,
        overId,
        String(args.active),
        event.code === 'ArrowRight' ? 1 : -1,
      );
      const node = target === null ? null : args.context.droppableContainers.get(target)?.node.current;
      if (target === null || node === null || node === undefined) return args.currentCoordinates;
      keyboardTarget.current = target;
      const board = node.parentElement;
      if (board !== null) {
        const offset = node.getBoundingClientRect().left - board.getBoundingClientRect().left - 8;
        board.scrollLeft = Math.max(0, board.scrollLeft + offset);
      }
      return { x: node.getBoundingClientRect().left + 8, y: args.currentCoordinates.y };
    },
    [],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter, scrollBehavior: 'auto' }),
  );
  const dealsById = useMemo(() => new Map((board?.deals ?? []).map((d) => [d.id, d])), [board]);
  const stageName = (id: string | null) => stages.find((s) => s.id === id)?.name ?? 'column';

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    keyboardTarget.current = null;
    origin.current = { stageId: findColumn(columns, id) ?? '', columns };
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (over === null) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = findColumn(columns, activeKey);
    const to = findColumn(columns, overKey);
    if (from === null || to === null || from === to) return;
    setColumns((cols) => {
      const target = cols[to] ?? [];
      const overIndex = target.indexOf(overKey);
      const isBelow =
        over.rect !== null &&
        active.rect.current.translated !== null &&
        active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
      const index = overIndex < 0 ? target.length : overIndex + (isBelow ? 1 : 0);
      return moveBetween(cols, activeKey, to, index);
    });
  };

  const commit = (plan: MovePlan, lostReason?: string) => {
    const deal = dealsById.get(plan.dealId);
    if (deal === undefined) return;
    void qc.cancelQueries({ queryKey: boardKey });
    const previous = qc.getQueryData<BoardData>(boardKey);
    if (previous !== undefined) qc.setQueryData<BoardData>(boardKey, applyMove(previous, plan, lostReason));
    move.mutate({ plan, version: deal.version, lostReason, previous });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const activeKey = String(active.id);
    setActiveId(null);
    const start = origin.current;
    origin.current = null;
    const viaKeyboard = keyboardTarget.current;
    keyboardTarget.current = null;
    if ((over === null && viaKeyboard === null) || start === null) {
      if (start !== null) setColumns(start.columns);
      return;
    }
    let cols = columns;
    if (viaKeyboard !== null && findColumn(cols, activeKey) !== viaKeyboard) {
      cols = moveBetween(cols, activeKey, viaKeyboard, (cols[viaKeyboard] ?? []).length);
      setColumns(cols);
    }
    const overKey = over === null ? activeKey : String(over.id);
    const to = findColumn(cols, overKey);
    if (to !== null) {
      const ids = cols[to] ?? [];
      const oldIndex = ids.indexOf(activeKey);
      const overIndex = ids.indexOf(overKey);
      if (oldIndex >= 0 && overIndex >= 0 && oldIndex !== overIndex) {
        cols = moveBetween(cols, activeKey, to, overIndex);
        setColumns(cols);
      }
    }
    const before = start.columns[start.stageId] ?? [];
    const after = cols[findColumn(cols, activeKey) ?? ''] ?? [];
    const plan = planMove(cols, board?.deals ?? [], activeKey);
    if (plan === null) return;
    if (plan.stageId === start.stageId && before.join() === after.join()) return;
    const targetStage = stages.find((s) => s.id === plan.stageId);
    if (targetStage?.kind === 'lost' && plan.stageId !== start.stageId) {
      setPendingLost({ plan, revert: start.columns });
      return;
    }
    commit(plan);
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${dealsById.get(String(active.id))?.title ?? 'deal'}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${dealsById.get(String(active.id))?.title ?? 'Deal'} is over ${stageName(findColumn(columns, String(over.id)))}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${dealsById.get(String(active.id))?.title ?? 'deal'} in ${stageName(findColumn(columns, String(over.id)))}.`
        : 'Drop cancelled.',
    onDragCancel: () => 'Drag cancelled.',
  };

  if (query.isLoading) {
    return (
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[60vh] w-72 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError || board === undefined) {
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title="Could not load the board"
        description={errorMessage(query.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw /> Retry
          </Button>
        }
      />
    );
  }
  const active = activeId === null ? null : (dealsById.get(activeId) ?? null);
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          keyboardTarget.current = null;
          if (origin.current !== null) setColumns(origin.current.columns);
          origin.current = null;
        }}
        accessibility={{ announcements }}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2" data-testid="kanban">
          {stages.map((s) => (
            <Column
              key={s.id}
              stage={s}
              ids={columns[s.id] ?? []}
              dealsById={dealsById}
              flash={flash}
              currency={me.tenant.settings.currency}
              onOpen={(id) => void navigate({ to: '/deals/$id', params: { id } })}
              onCreate={onCreate}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180 }}>
          {active ? <DealCard deal={active} overlay /> : null}
        </DragOverlay>
      </DndContext>
      <LostReasonDialog
        open={pendingLost !== null}
        dealTitle={pendingLost ? (dealsById.get(pendingLost.plan.dealId)?.title ?? '') : ''}
        onCancel={() => {
          if (pendingLost !== null) setColumns(pendingLost.revert);
          setPendingLost(null);
        }}
        onConfirm={(reason) => {
          if (pendingLost !== null) commit(pendingLost.plan, reason);
          setPendingLost(null);
        }}
      />
    </>
  );
}
