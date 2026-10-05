import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@bop/contracts';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  NativeSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@bop/ui';
import { ChevronsUpDown, X } from 'lucide-react';
import { api } from '../lib/api';
import { useMembers } from '../lib/data';
import { useDebounced } from '../lib/hooks';
import { ENTITY_PATH, keys, type RecordEntity } from '../lib/query-keys';

export function UserPicker({
  value,
  onChange,
  id,
  testId,
  allowEmpty = true,
  placeholder = 'Unassigned',
  className,
  disabled,
}: {
  value: string | null | undefined;
  onChange(value: string | null): void;
  id?: string;
  testId?: string;
  allowEmpty?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const { data: members } = useMembers();
  return (
    <NativeSelect
      id={id}
      data-testid={testId}
      value={value ?? ''}
      disabled={disabled}
      className={className}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      {allowEmpty ? <option value="">{placeholder}</option> : null}
      {(members ?? []).map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </NativeSelect>
  );
}

function titleOf(entity: RecordEntity, row: Record<string, unknown>): string {
  if (entity === 'invoice') return String(row['number'] ?? '');
  if (entity === 'deal' || entity === 'task') return String(row['title'] ?? '');
  return String(row['name'] ?? '');
}

export function useRecordTitle(entity: RecordEntity | null, id: string | null | undefined, known?: string | null) {
  return useQuery({
    queryKey: ['record-title', entity, id],
    queryFn: async () =>
      titleOf(
        entity as RecordEntity,
        await api.get<Record<string, unknown>>(`/v1/${ENTITY_PATH[entity as RecordEntity]}/${id}`),
      ),
    enabled: entity !== null && typeof id === 'string' && id !== '' && (known === undefined || known === null),
    staleTime: 300_000,
  });
}

export function RecordPicker({
  entity,
  value,
  label,
  onChange,
  placeholder,
  testId,
  className,
  disabled,
}: {
  entity: RecordEntity;
  value: string | null | undefined;
  label?: string | null;
  onChange(id: string | null, title: string | null): void;
  placeholder?: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 150);
  const title = useRecordTitle(entity, value, label);
  const results = useQuery({
    queryKey: keys.search(`${entity}:${debounced}`),
    queryFn: async () => {
      if (debounced.trim() === '') {
        const page = await api.get<{ items: Array<Record<string, unknown>> }>(`/v1/${ENTITY_PATH[entity]}`, {
          query: { limit: 20 },
        });
        return page.items.map((r) => ({
          id: String(r['id']),
          title: titleOf(entity, r),
          subtitle: null as string | null,
        }));
      }
      const res = await api.get<SearchResult>('/v1/search', { query: { q: debounced } });
      return (res.groups.find((g) => g.entity === entity)?.hits ?? []).map((h) => ({
        id: h.id,
        title: h.title,
        subtitle: h.subtitle,
      }));
    },
    enabled: open,
  });
  const shown = label ?? title.data ?? (value ? '…' : null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('flex w-full items-center gap-1', className)}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-9 w-full justify-between px-3 font-normal"
            data-testid={testId}
            disabled={disabled}
          >
            <span className={cn('truncate', shown === null && 'text-muted-foreground')}>
              {shown ?? placeholder ?? `Select ${entity}`}
            </span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        {value && !disabled ? (
          <Button variant="ghost" size="icon-sm" aria-label="Clear" onClick={() => onChange(null, null)}>
            <X />
          </Button>
        ) : null}
      </div>
      <PopoverContent className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${entity}…`} value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>{results.isFetching ? 'Searching…' : 'No results'}</CommandEmpty>
            <CommandGroup>
              {(results.data ?? []).map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.id}
                  onSelect={() => {
                    onChange(r.id, r.title);
                    setOpen(false);
                  }}
                >
                  <div className="grid">
                    <span>{r.title}</span>
                    {r.subtitle ? <span className="text-xs text-muted-foreground">{r.subtitle}</span> : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
