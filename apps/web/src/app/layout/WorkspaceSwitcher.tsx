import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  toast,
} from '@bop/ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { errorMessage, switchTenant } from '../../lib/api';
import { useMe } from '../auth';

export function WorkspaceSwitcher() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="workspace-switcher"
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            {me.tenant.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{me.tenant.name}</span>
            <span className="block truncate text-[11px] capitalize text-muted-foreground">{me.role}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {me.tenants.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => {
              if (t.id === me.tenant.id) return;
              void switchTenant(t.id)
                .then(() => {
                  qc.clear();
                  void navigate({ to: '/deals' });
                  toast.success(`Switched to ${t.name}`);
                })
                .catch((e: unknown) => toast.error(errorMessage(e)));
            }}
          >
            <span className="flex-1 truncate">{t.name}</span>
            <span className="text-[11px] capitalize text-muted-foreground">{t.role}</span>
            {t.id === me.tenant.id ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
