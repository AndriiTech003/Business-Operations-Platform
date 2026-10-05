import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge, cn } from '@bop/ui';
import {
  Building,
  ChartBar,
  CircleCheck,
  Handshake,
  Inbox,
  ListTodo,
  type LucideIcon,
  Receipt,
  Settings,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { keys } from '../../lib/query-keys';
import { usePollInterval } from '../../lib/realtime';
import { useAuth } from '../auth';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

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

interface NavItem {
  name: string;
  label: string;
  to: NavTo;
  icon: LucideIcon;
}

const SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'CRM',
    items: [
      { name: 'companies', label: 'Companies', to: '/companies', icon: Building },
      { name: 'contacts', label: 'Contacts', to: '/contacts', icon: Users },
      { name: 'deals', label: 'Deals', to: '/deals', icon: Handshake },
      { name: 'invoices', label: 'Invoices', to: '/invoices', icon: Receipt },
      { name: 'tasks', label: 'My tasks', to: '/tasks', icon: ListTodo },
    ],
  },
  {
    title: 'Automation',
    items: [
      { name: 'workflows', label: 'Workflows', to: '/workflows', icon: Workflow },
      { name: 'runs', label: 'Runs', to: '/runs', icon: Zap },
      { name: 'approvals', label: 'Approvals', to: '/approvals', icon: Inbox },
    ],
  },
  {
    title: 'Insights',
    items: [
      { name: 'reports', label: 'Reports', to: '/reports', icon: ChartBar },
      { name: 'settings', label: 'Settings', to: '/settings', icon: Settings },
    ],
  },
];

function ApprovalsBadge() {
  const { can } = useAuth();
  const interval = usePollInterval(15_000);
  const { data } = useQuery({
    queryKey: keys.approvals.count,
    queryFn: () => api.get<{ count: number }>('/v1/approvals/count'),
    enabled: can('approvals:read'),
    refetchInterval: interval === false ? 60_000 : interval,
  });
  const count = data?.count ?? 0;
  if (count === 0) return null;
  return (
    <Badge
      variant="destructive"
      className="ml-auto h-5 min-w-5 justify-center bg-destructive px-1.5 text-white"
      data-testid="approvals-badge"
      aria-label={`${count} pending approvals`}
    >
      {count > 99 ? '99+' : count}
    </Badge>
  );
}

export function Sidebar() {
  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground"
      aria-label="Main navigation"
    >
      <div className="border-b p-2">
        <WorkspaceSwitcher />
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-3">
            <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {section.title}
            </p>
            <ul className="grid gap-0.5">
              {section.items.map((item) => (
                <li key={item.name}>
                  <Link
                    to={item.to}
                    data-testid={`nav-${item.name}`}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-foreground',
                    )}
                    activeProps={{ className: 'bg-sidebar-accent text-foreground', 'aria-current': 'page' }}
                    activeOptions={{ includeSearch: false }}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.name === 'approvals' ? <ApprovalsBadge /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t p-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CircleCheck className="size-3 text-success" /> Durable workflow engine
        </span>
      </div>
    </aside>
  );
}
