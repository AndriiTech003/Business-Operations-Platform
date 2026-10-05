import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { SearchResult } from '@bop/contracts';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Spinner } from '@bop/ui';
import {
  Building,
  ChartBar,
  SquareCheck,
  FileText,
  Handshake,
  Inbox,
  ListTodo,
  type LucideIcon,
  Plus,
  Receipt,
  Settings,
  User,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { keys } from '../../lib/query-keys';
import { recordHref } from '../../components/record-links';

const ENTITY_META: Record<string, { label: string; icon: LucideIcon }> = {
  company: { label: 'Companies', icon: Building },
  contact: { label: 'Contacts', icon: User },
  deal: { label: 'Deals', icon: Handshake },
  invoice: { label: 'Invoices', icon: FileText },
  task: { label: 'Tasks', icon: SquareCheck },
};

type NavTo =
  | '/companies'
  | '/contacts'
  | '/deals'
  | '/invoices'
  | '/tasks'
  | '/workflows'
  | '/runs'
  | '/approvals'
  | '/reports'
  | '/settings';

const NAV: Array<{ label: string; to: NavTo; icon: LucideIcon }> = [
  { label: 'Companies', to: '/companies', icon: Building },
  { label: 'Contacts', to: '/contacts', icon: Users },
  { label: 'Deals board', to: '/deals', icon: Handshake },
  { label: 'Invoices', to: '/invoices', icon: Receipt },
  { label: 'My tasks', to: '/tasks', icon: ListTodo },
  { label: 'Workflows', to: '/workflows', icon: Workflow },
  { label: 'Workflow runs', to: '/runs', icon: Zap },
  { label: 'Approvals inbox', to: '/approvals', icon: Inbox },
  { label: 'Reports', to: '/reports', icon: ChartBar },
  { label: 'Settings', to: '/settings', icon: Settings },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 150);
  const navigate = useNavigate();
  const { data, isFetching } = useQuery({
    queryKey: keys.search(debounced),
    queryFn: ({ signal }) => api.get<SearchResult>('/v1/search', { query: { q: debounced }, signal }),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });
  const close = () => {
    onOpenChange(false);
    setQ('');
  };
  const lower = q.trim().toLowerCase();
  const nav = NAV.filter((n) => lower === '' || n.label.toLowerCase().includes(lower));
  const groups = debounced.length >= 2 ? (data?.groups ?? []).filter((g) => g.hits.length > 0) : [];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[15vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-2xl data-[state=open]:animate-fade-in"
          aria-describedby={undefined}
          data-testid="command-palette"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command shouldFilter={false} loop>
            <CommandInput
              placeholder="Search companies, contacts, deals, invoices…"
              value={q}
              onValueChange={setQ}
              data-testid="command-input"
            />
            <CommandList>
              <CommandEmpty>
                {isFetching ? <Spinner /> : debounced.length >= 2 ? `No results for "${debounced}"` : 'Type to search'}
              </CommandEmpty>
              {groups.map((g) => {
                const meta = ENTITY_META[g.entity] ?? { label: g.entity, icon: FileText };
                return (
                  <CommandGroup key={g.entity} heading={meta.label}>
                    {g.hits.map((h) => (
                      <CommandItem
                        key={`${g.entity}-${h.id}`}
                        value={`${g.entity}-${h.id}`}
                        data-testid="search-hit"
                        onSelect={() => {
                          close();
                          if (g.entity === 'task') void navigate({ to: '/tasks' });
                          else void navigate(recordHref(g.entity, h.id));
                        }}
                      >
                        <meta.icon />
                        <span className="truncate">{h.title}</span>
                        {h.subtitle ? (
                          <span className="ml-auto truncate text-xs text-muted-foreground">{h.subtitle}</span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
              {nav.length > 0 ? (
                <CommandGroup heading="Go to">
                  {nav.map((n) => (
                    <CommandItem
                      key={n.to}
                      value={`nav-${n.to}`}
                      onSelect={() => {
                        close();
                        void navigate({ to: n.to });
                      }}
                    >
                      <n.icon />
                      {n.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {lower === '' || 'new workflow'.includes(lower) ? (
                <CommandGroup heading="Actions">
                  <CommandItem
                    value="action-new-workflow"
                    onSelect={() => {
                      close();
                      void navigate({ to: '/workflows' });
                    }}
                  >
                    <Plus /> New workflow from template
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
