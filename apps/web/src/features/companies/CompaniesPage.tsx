import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { CompanyDto } from '@bop/contracts';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
} from '@bop/ui';
import { Building, CopyCheck, Ellipsis, FileUp, Plus, Trash2 } from 'lucide-react';
import { DataTable, type ColumnSpec } from '../../components/data-table/DataTable';
import { DuplicatesDialog } from '../../components/DuplicatesDialog';
import { ImportDialog } from '../../components/ImportDialog';
import { Page, PageHeader } from '../../components/PageHeader';
import { useCustomFieldsFor } from '../../lib/data';
import { useDeleteRecords, useInlineEdit, useRecordList } from '../../lib/records';
import { customFieldSpecs, type TableSearch } from '../../lib/table';
import { useAuth } from '../../app/auth';
import { COMPANY_COLUMNS, COMPANY_DEFAULT_COLUMNS } from './columns';
import { CreateCompanyDialog } from './CreateCompanyDialog';

const route = getRouteApi('/app/companies');

export function CompaniesPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { can } = useAuth();
  const defs = useCustomFieldsFor('company');
  const columns = useMemo<ColumnSpec<CompanyDto>[]>(() => [...COMPANY_COLUMNS, ...customFieldSpecs(defs)], [defs]);
  const query = useRecordList<CompanyDto>('company', search);
  const edit = useInlineEdit<CompanyDto>('company');
  const del = useDeleteRecords('company');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dups, setDups] = useState(false);
  const [confirm, setConfirm] = useState<{ ids: string[]; clear(): void } | null>(null);
  const setSearch = (next: TableSearch) => void navigate({ to: '/companies', search: next, replace: true });
  const writable = can('records:write');

  return (
    <Page>
      <PageHeader
        icon={<Building />}
        title="Companies"
        description="Accounts you sell to"
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="More actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => setImporting(true)}
                  disabled={!writable}
                  data-testid="import-companies"
                >
                  <FileUp /> Import CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDups(true)} data-testid="find-duplicates">
                  <CopyCheck /> Find duplicates
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" onClick={() => setCreating(true)} disabled={!writable} data-testid="create-company">
              <Plus /> New company
            </Button>
          </>
        }
      />
      <DataTable
        entity="companies"
        columns={columns}
        defaultColumns={COMPANY_DEFAULT_COLUMNS}
        search={search}
        onSearchChange={setSearch}
        query={query}
        searchPlaceholder="Search companies…"
        onRowClick={(r) => void navigate({ to: '/companies/$id', params: { id: r.id } })}
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
        empty={
          <EmptyState
            icon={<Building />}
            title={search.filter?.length || search.q ? 'No companies match' : 'No companies yet'}
            description="Add your first company or import a CSV."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New company
              </Button>
            }
          />
        }
      />
      <CreateCompanyDialog open={creating} onOpenChange={setCreating} />
      <ImportDialog entity="company" open={importing} onOpenChange={setImporting} />
      <DuplicatesDialog entity="company" open={dups} onOpenChange={setDups} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => (o ? undefined : setConfirm(null))}
        title={`Delete ${confirm?.ids.length ?? 0} companies?`}
        description="They will be moved to trash (soft delete)."
        destructive
        confirmLabel="Delete"
        confirmTestId="confirm-delete"
        onConfirm={() => {
          if (confirm !== null) {
            del.mutate(confirm.ids);
            confirm.clear();
          }
          setConfirm(null);
        }}
      />
    </Page>
  );
}
