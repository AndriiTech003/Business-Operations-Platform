import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { Page } from '@bop/contracts';
import { Button, Checkbox, EmptyState, Input, Skeleton, Spinner, cn } from '@bop/ui';
import { ArrowDown, ArrowUp, ChevronsUpDown, Pencil, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { getPath, nextSort, sortDirection, type FieldSpec, type TableSearch } from '../../lib/table';
import { FieldInput } from '../FieldInput';
import { FieldValue } from '../FieldValue';
import { ColumnChooser } from './ColumnChooser';
import { FilterChips } from './FilterChips';
import { SavedViews } from './SavedViews';

export interface ColumnSpec<T> extends FieldSpec {
  render?(row: T): ReactNode;
  value?(row: T): unknown;
}

export interface DataTableProps<T extends { id: string }> {
  entity: string;
  columns: ColumnSpec<T>[];
  defaultColumns: string[];
  search: TableSearch;
  onSearchChange(next: TableSearch): void;
  query: UseInfiniteQueryResult<InfiniteData<Page<T>, unknown>, Error>;
  onRowClick?(row: T): void;
  onCellEdit?(row: T, column: ColumnSpec<T>, value: unknown): void;
  bulkActions?(rows: T[], clear: () => void): ReactNode;
  toolbar?: ReactNode;
  empty?: ReactNode;
  searchPlaceholder?: string;
  rowTestId?(row: T): string;
  currencyOf?(row: T): string | undefined;
}

const ROW_HEIGHT = 40;
const IMMEDIATE = new Set(['select', 'user', 'date', 'bool', 'multi_select']);

function InlineEditor<T>({
  row,
  column,
  onCommit,
  onCancel,
}: {
  row: T;
  column: ColumnSpec<T>;
  onCommit(value: unknown): void;
  onCancel(): void;
}) {
  const initial = column.value ? column.value(row) : getPath(row, column.key);
  const [draft, setDraft] = useState<unknown>(initial);
  const done = useRef(false);
  const commit = (v: unknown) => {
    if (done.current) return;
    done.current = true;
    if (JSON.stringify(v ?? null) === JSON.stringify(initial ?? null)) onCancel();
    else onCommit(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(draft);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      done.current = true;
      onCancel();
    }
  };
  return (
    <div className="w-full" onClick={(e) => e.stopPropagation()} data-testid={`inline-editor-${column.key}`}>
      <FieldInput
        spec={column}
        value={draft}
        autoFocus
        className="h-7 text-sm"
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        onChange={(v) => {
          setDraft(v);
          if (IMMEDIATE.has(column.type)) commit(v);
        }}
      />
    </div>
  );
}

export function DataTable<T extends { id: string }>({
  entity,
  columns,
  defaultColumns,
  search,
  onSearchChange,
  query,
  onRowClick,
  onCellEdit,
  bulkActions,
  toolbar,
  empty,
  searchPlaceholder = 'Search…',
  rowTestId,
  currencyOf,
}: DataTableProps<T>) {
  const [q, setQ] = useState(search.q ?? '');
  const debouncedQ = useDebounced(q, 300);
  const searchRef = useRef(search);
  const changeRef = useRef(onSearchChange);
  useEffect(() => {
    searchRef.current = search;
    changeRef.current = onSearchChange;
  });
  useEffect(() => {
    if ((searchRef.current.q ?? '') !== debouncedQ)
      changeRef.current({ ...searchRef.current, q: debouncedQ || undefined });
  }, [debouncedQ]);
  const externalQ = search.q ?? '';
  const debouncedRef = useRef(debouncedQ);
  useEffect(() => {
    debouncedRef.current = debouncedQ;
  });
  useEffect(() => {
    if (externalQ !== debouncedRef.current) setQ(externalQ);
  }, [externalQ]);

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null);
  const visibleKeys = search.cols ?? defaultColumns;
  const visible = useMemo(
    () => visibleKeys.map((k) => columns.find((c) => c.key === k)).filter((c): c is ColumnSpec<T> => c !== undefined),
    [visibleKeys, columns],
  );
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const columnDefs = useMemo<ColumnDef<T>[]>(
    () =>
      visible.map((c) => ({
        id: c.key,
        header: c.label,
        accessorFn: (row: T) => (c.value ? c.value(row) : getPath(row, c.key)),
        size: c.width ?? 160,
      })),
    [visible],
  );
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getRowId: (r) => r.id,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    enableRowSelection: bulkActions !== undefined,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
  });
  const tableRows = table.getRowModel().rows;
  const selected = table.getSelectedRowModel().rows.map((r) => r.original);
  const clearSelection = () => setRowSelection({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current !== null) clearTimeout(clickTimer.current);
    },
    [],
  );
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? (items[items.length - 1]?.index ?? 0) : 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= tableRows.length - 15) void fetchNextPage();
  }, [lastIndex, tableRows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const selectWidth = bulkActions !== undefined ? 40 : 0;
  const template = `${selectWidth > 0 ? `${selectWidth}px ` : ''}${visible.map((c) => `minmax(${c.width ?? 160}px, ${c.width ?? 160}fr)`).join(' ')}`;
  const minWidth = selectWidth + visible.reduce((s, c) => s + (c.width ?? 160), 0);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(tableRows.length - 1, index));
    virtualizer.scrollToIndex(clamped);
    requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.focus());
  };

  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search"
            data-testid="table-search"
            className="h-9 pl-8"
            placeholder={searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <FilterChips
          fields={columns}
          value={search.filter ?? []}
          onChange={(filter) => onSearchChange({ ...search, filter: filter.length === 0 ? undefined : filter })}
        />
        <div className="ml-auto flex items-center gap-2">
          <SavedViews entity={entity} search={search} onApply={onSearchChange} />
          <ColumnChooser
            columns={columns}
            visible={visibleKeys}
            defaultColumns={defaultColumns}
            onChange={(cols) => onSearchChange({ ...search, cols })}
          />
          {toolbar}
        </div>
      </div>

      {selected.length > 0 && bulkActions !== undefined ? (
        <div
          className="flex items-center gap-2 rounded-lg border bg-accent/50 px-3 py-1.5 text-sm"
          data-testid="bulk-bar"
        >
          <span className="font-medium">{selected.length} selected</span>
          <div className="flex items-center gap-1">{bulkActions(selected, clearSelection)}</div>
          <Button variant="ghost" size="xs" className="ml-auto" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
        <div
          ref={scrollRef}
          className="h-full overflow-auto"
          role="table"
          aria-rowcount={tableRows.length}
          data-testid={`table-${entity}`}
        >
          <div style={{ minWidth }}>
            <div
              role="row"
              className="sticky top-0 z-10 grid border-b bg-muted/70 backdrop-blur"
              style={{ gridTemplateColumns: template }}
            >
              {selectWidth > 0 ? (
                <div role="columnheader" className="flex h-9 items-center justify-center">
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
                  />
                </div>
              ) : null}
              {visible.map((c) => {
                const dir = sortDirection(search.sort, c.key);
                const sortable = c.sortable !== false;
                return (
                  <div
                    key={c.key}
                    role="columnheader"
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                    className="flex h-9 min-w-0 items-center px-3"
                  >
                    {sortable ? (
                      <button
                        type="button"
                        data-testid={`sort-${c.key}`}
                        className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        onClick={() => onSearchChange({ ...search, sort: nextSort(search.sort, c.key) })}
                      >
                        <span className="truncate">{c.label}</span>
                        {dir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : dir === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      <span className="truncate text-xs font-medium text-muted-foreground">{c.label}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {query.isLoading ? (
              <div className="grid gap-px p-2">
                {Array.from({ length: 10 }, (_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : query.isError ? (
              <div className="p-6">
                <EmptyState
                  icon={<TriangleAlert />}
                  title="Could not load records"
                  description={errorMessage(query.error)}
                  action={
                    <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                      <RefreshCw /> Retry
                    </Button>
                  }
                />
              </div>
            ) : tableRows.length === 0 ? (
              <div className="p-6">
                {empty ?? <EmptyState title="Nothing here yet" description="No records match the current filters." />}
              </div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {items.map((vi) => {
                  const row = tableRows[vi.index];
                  if (row === undefined) return null;
                  const original = row.original;
                  return (
                    <div
                      key={row.id}
                      role="row"
                      tabIndex={0}
                      data-index={vi.index}
                      data-testid={rowTestId ? rowTestId(original) : `row-${row.id}`}
                      data-state={row.getIsSelected() ? 'selected' : undefined}
                      aria-selected={row.getIsSelected()}
                      className={cn(
                        'absolute left-0 top-0 grid w-full cursor-pointer border-b text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-accent/60 data-[state=selected]:bg-accent/50',
                      )}
                      style={{
                        gridTemplateColumns: template,
                        height: ROW_HEIGHT,
                        transform: `translateY(${vi.start}px)`,
                      }}
                      onClick={() => {
                        if (onRowClick === undefined) return;
                        if (clickTimer.current !== null) clearTimeout(clickTimer.current);
                        clickTimer.current = setTimeout(() => onRowClick(original), onCellEdit ? 230 : 0);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter') onRowClick?.(original);
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          focusRow(vi.index + 1);
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          focusRow(vi.index - 1);
                        }
                        if (e.key === ' ' && bulkActions !== undefined) {
                          e.preventDefault();
                          row.toggleSelected();
                        }
                      }}
                    >
                      {selectWidth > 0 ? (
                        <div
                          role="cell"
                          className="flex items-center justify-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            aria-label="Select row"
                            checked={row.getIsSelected()}
                            onCheckedChange={(v) => row.toggleSelected(v === true)}
                          />
                        </div>
                      ) : null}
                      {visible.map((c) => {
                        const isEditing = editing?.rowId === row.id && editing.key === c.key;
                        const editable = c.editable === true && onCellEdit !== undefined && c.type !== 'relation';
                        return (
                          <div
                            key={c.key}
                            role="cell"
                            data-testid={`cell-${c.key}`}
                            className="group/cell relative flex min-w-0 items-center px-3"
                            onDoubleClick={(e) => {
                              if (!editable) return;
                              e.stopPropagation();
                              if (clickTimer.current !== null) clearTimeout(clickTimer.current);
                              setEditing({ rowId: row.id, key: c.key });
                            }}
                          >
                            {isEditing ? (
                              <InlineEditor
                                row={original}
                                column={c}
                                onCancel={() => setEditing(null)}
                                onCommit={(value) => {
                                  setEditing(null);
                                  onCellEdit?.(original, c, value);
                                }}
                              />
                            ) : (
                              <>
                                <div className="min-w-0 flex-1 truncate">
                                  {c.render ? (
                                    c.render(original)
                                  ) : (
                                    <FieldValue
                                      spec={c}
                                      value={c.value ? c.value(original) : getPath(original, c.key)}
                                      currency={currencyOf?.(original)}
                                    />
                                  )}
                                </div>
                                {editable ? (
                                  <button
                                    type="button"
                                    aria-label={`Edit ${c.label}`}
                                    data-testid={`edit-${c.key}`}
                                    className="ml-1 hidden cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted group-hover/cell:inline-flex focus-visible:inline-flex"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditing({ rowId: row.id, key: c.key });
                                    }}
                                  >
                                    <Pencil className="size-3" />
                                  </button>
                                ) : null}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
            {isFetchingNextPage ? (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Loading more…
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span data-testid="table-count">
          {rows.length} loaded{hasNextPage ? ' · scroll for more' : ''}
        </span>
        {query.isFetching && !query.isLoading ? <Spinner className="size-3" /> : null}
      </div>
    </div>
  );
}
