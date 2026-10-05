import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { ContactDto } from '@bop/contracts';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
} from '@bop/ui';
import { Users, CopyCheck, Ellipsis, FileUp, Plus, Trash2 } from 'lucide-react';
import { DataTable, type ColumnSpec } from '../../components/data-table/DataTable';
import { DuplicatesDialog } from '../../components/DuplicatesDialog';
import { ImportDialog } from '../../components/ImportDialog';
import { Page, PageHeader } from '../../components/PageHeader';
import { useCustomFieldsFor } from '../../lib/data';
import { useDeleteRecords, useInlineEdit, useRecordList } from '../../lib/records';
import { customFieldSpecs, type TableSearch } from '../../lib/table';
import { useAuth } from '../../app/auth';
import { CONTACT_COLUMNS, CONTACT_DEFAULT_COLUMNS } from './columns';
import { CreateContactDialog } from './CreateContactDialog';

const route = getRouteApi('/app/contacts');

export function ContactsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { can } = useAuth();
  const defs = useCustomFieldsFor('contact');
  const columns = useMemo<ColumnSpec<ContactDto>[]>(() => [...CONTACT_COLUMNS, ...customFieldSpecs(defs)], [defs]);
  const query = useRecordList<ContactDto>('contact', search);
  const edit = useInlineEdit<ContactDto>('contact');
  const del = useDeleteRecords('contact');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dups, setDups] = useState(false);
  const [confirm, setConfirm] = useState<{ ids: string[]; clear(): void } | null>(null);
  const setSearch = (next: TableSearch) => void navigate({ to: '/contacts', search: next, replace: true });
  const writable = can('records:write');

  return (
    <Page>
      <PageHeader
        icon={<Users />}
        title="Contacts"
        description="People at your customers and leads"
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
                  data-testid="import-contacts"
                >
                  <FileUp /> Import CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDups(true)} data-testid="find-duplicates">
                  <CopyCheck /> Find duplicates
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" onClick={() => setCreating(true)} disabled={!writable} data-testid="create-contact">
              <Plus /> New contact
            </Button>
          </>
        }
      />
      <DataTable
        entity="contacts"
        columns={columns}
        defaultColumns={CONTACT_DEFAULT_COLUMNS}
        search={search}
        onSearchChange={setSearch}
        query={query}
        searchPlaceholder="Search contacts…"
        onRowClick={(r) => void navigate({ to: '/contacts/$id', params: { id: r.id } })}
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
            icon={<Users />}
            title={search.filter?.length || search.q ? 'No contacts match' : 'No contacts yet'}
            description="Add your first contact or import a CSV."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New contact
              </Button>
            }
          />
        }
      />
      <CreateContactDialog open={creating} onOpenChange={setCreating} />
      <ImportDialog entity="contact" open={importing} onOpenChange={setImporting} />
      <DuplicatesDialog entity="contact" open={dups} onOpenChange={setDups} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => (o ? undefined : setConfirm(null))}
        title={`Delete ${confirm?.ids.length ?? 0} contacts?`}
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
