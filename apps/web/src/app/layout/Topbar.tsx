import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Tooltip,
} from '@bop/ui';
import { LogOut, Moon, Search, Settings, Sun, Wifi, WifiOff } from 'lucide-react';
import { logout } from '../../lib/api';
import { useHotkey } from '../../lib/hooks';
import { useRealtimeStatus } from '../../lib/realtime';
import { useTheme } from '../../lib/theme';
import { NotificationsBell } from '../../features/notifications/NotificationsBell';
import { useMe } from '../auth';
import { CommandPalette } from './CommandPalette';

function RealtimeIndicator() {
  const status = useRealtimeStatus();
  const live = status === 'open';
  const label = live
    ? 'Live updates connected'
    : status === 'unavailable'
      ? 'Realtime unavailable — polling for updates'
      : 'Connecting to realtime…';
  return (
    <Tooltip content={label}>
      <span
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
        data-testid="realtime-status"
        data-status={status}
      >
        {live ? <Wifi className="size-3 text-success" /> : <WifiOff className="size-3" />}
        {live ? 'Live' : status === 'unavailable' ? 'Polling' : '…'}
      </span>
    </Tooltip>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={theme === 'dark'}
        data-testid="theme-toggle"
        data-theme={theme}
        onClick={() => setTheme(next)}
        className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
    </Tooltip>
  );
}

function UserMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="cursor-pointer rounded-full" aria-label="User menu" data-testid="user-menu">
          <Avatar id={me.user.id} name={me.user.name} size="md" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid">
          <span className="text-sm text-foreground">{me.user.name}</span>
          <span className="font-normal">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: '/settings' })}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="logout"
          onSelect={() => {
            void logout().finally(() => {
              qc.clear();
              void navigate({ to: '/login' });
            });
          }}
        >
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar() {
  const [open, setOpen] = useState(false);
  useHotkey('mod+k', (e) => {
    e.preventDefault();
    setOpen((o) => !o);
  });
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur">
      <button
        type="button"
        data-testid="command-palette-trigger"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-md cursor-pointer items-center gap-2 rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search records, jump to…</span>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </button>
      <div className="ml-auto flex items-center gap-2">
        <RealtimeIndicator />
        <ThemeToggle />
        <NotificationsBell />
        <UserMenu />
      </div>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </header>
  );
}
