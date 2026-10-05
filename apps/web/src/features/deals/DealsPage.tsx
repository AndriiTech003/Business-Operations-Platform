import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { DealDto } from '@bop/contracts';
import { Button, ConfirmDialog, NativeSelect, Segmented } from '@bop/ui';
import { Handshake, KanbanSquare, Plus, Table2, Trash2, TrendingUp } from 'lucide-react';
import { DataTable, type ColumnSpec } from '../../components/data-table/DataTable';
import { Page, PageHeader } from '../../components/PageHeader';
import { PanelBoundary } from '../../components/PanelBoundary';
import { useCustomFieldsFor, usePipelines } from '../../lib/data';
import { useDeleteRecords, useInlineEdit, useRecordList } from '../../lib/records';
import { customFieldSpecs } from '../../lib/table';
import { useAuth } from '../../app/auth';
import { DEAL_DEFAULT_COLUMNS, dealColumns } from './columns';
import { CreateDealDialog } from './CreateDealDialog';
import { ForecastPanel } from './ForecastPanel';
import { Kanban } from './Kanban';
import type { dealsSearch } from '../../app/search';
import type { z } from 'zod';

const route = getRouteApi('/app/deals');
type DealsSearch = z.infer<typeof dealsSearch>;

function DealsTable({ search, setSearch }: { search: DealsSearch; setSearch(s: DealsSearch): void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: pipelines } = usePipelines();
  const defs = useCustomFieldsFor('deal');
  const stages = useMemo(() => (pipelines ?? []).flatMap((p) => p.stages), [pipelines]);
  const columns = useMemo<ColumnSpec<DealDto>[]>(
    () => [...dealColumns(stages), ...customFieldSpecs(defs)],
    [stages, defs],
  );
  const query = useRecordList<DealDto>('deal', search);
  const edit = useInlineEdit<DealDto>('deal');
  const del = useDeleteRecords('deal');
  const [confirm, setConfirm] = useState<{ ids: string[]; clear(): void } | null>(null);
  const writable = can('records:write');
  return (
    <>
      <DataTable
        entity="deals"
        columns={columns}
        defaultColumns={DEAL_DEFAULT_COLUMNS}
        search={search}
        onSearchChange={(next) => setSearch({ ...next, view: 'table', pipelineId: search.pipelineId })}
        query={query}
        searchPlaceholder="Search deals…"
        currencyOf={(r) => r.currency}
        onRowClick={(r) => void navigate({ to: '/deals/$id', params: { id: r.id } })}
        onCellEdit={writable ? (row, col, value) => edit.mutate({ row, key: col.key, value }) : undefined}
        bulkActions={
          writable
            ? (rows, clear) => (
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => setConfirm({ ids: rows.map((r) => r.id), clear })}
                  data-testid="bulk-delete"
                >
                  <Trash2 /> Delete
                </Button>
              )
            : undefined
        }
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => (o ? undefined : setConfirm(null))}
        title={`Delete ${confirm?.ids.length ?? 0} deals?`}
        destructive
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirm !== null) {
            del.mutate(confirm.ids);
            confirm.clear();
          }
          setConfirm(null);
        }}
      />
    </>
  );
}

export function DealsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: pipelines } = usePipelines();
  const view = search.view ?? 'board';
  const pipeline =
    pipelines?.find((p) => p.id === search.pipelineId) ?? pipelines?.find((p) => p.isDefault) ?? pipelines?.[0];
  const [creating, setCreating] = useState<{ stageId?: string } | null>(null);
  const setSearch = (next: DealsSearch) => void navigate({ to: '/deals', search: next, replace: true });

  return (
    <Page className="min-h-full">
      <PageHeader
        icon={<Handshake />}
        title="Deals"
        description={pipeline ? `${pipeline.name} pipeline` : 'Pipeline'}
        actions={
          <>
            {(pipelines?.length ?? 0) > 1 ? (
              <NativeSelect
                aria-label="Pipeline"
                className="h-8 w-44"
                value={pipeline?.id ?? ''}
                onChange={(e) => setSearch({ ...search, pipelineId: e.target.value })}
              >
                {pipelines?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <Segmented
              ariaLabel="View"
              value={view}
              onChange={(v) => setSearch({ ...search, view: v })}
              options={[
                {
                  value: 'board',
                  label: (
                    <>
                      <KanbanSquare /> Board
                    </>
                  ),
                  testId: 'view-board',
                },
                {
                  value: 'table',
                  label: (
                    <>
                      <Table2 /> Table
                    </>
                  ),
                  testId: 'view-table',
                },
              ]}
            />
            {view === 'board' ? (
              <Button
                size="sm"
                variant={search.forecast ? 'secondary' : 'outline'}
                onClick={() => setSearch({ ...search, forecast: search.forecast ? undefined : true })}
                data-testid="toggle-forecast"
              >
                <TrendingUp /> Forecast
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => setCreating({})}
              disabled={!can('records:write')}
              data-testid="create-deal"
            >
              <Plus /> New deal
            </Button>
          </>
        }
      />
      {view === 'board' ? (
        <div className="flex min-h-[60vh] flex-1 gap-4">
          <PanelBoundary title="The board crashed">
            <Kanban pipelineId={pipeline?.id} onCreate={(stageId) => setCreating({ stageId })} />
          </PanelBoundary>
          {search.forecast ? (
            <PanelBoundary>
              <ForecastPanel pipelineId={pipeline?.id} />
            </PanelBoundary>
          ) : null}
        </div>
      ) : (
        <DealsTable search={search} setSearch={setSearch} />
      )}
      <CreateDealDialog
        open={creating !== null}
        onOpenChange={(o) => (o ? undefined : setCreating(null))}
        pipeline={pipeline}
        stageId={creating?.stageId}
      />
    </Page>
  );
}
