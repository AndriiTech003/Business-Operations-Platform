import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@bop/ui';
import { ChevronLeft, History, Info, Link2, ListTodo, MessageSquare } from 'lucide-react';
import { PanelBoundary } from '../PanelBoundary';
import { OperatorPanelSlot, type OperatorRecord } from '../../lib/operator';
import { LockBanner, PresenceAvatars } from './presence';

export interface RecordTab {
  value: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  content: ReactNode;
}

export const TAB_ICONS = {
  overview: <Info />,
  activity: <History />,
  tasks: <ListTodo />,
  related: <Link2 />,
  comments: <MessageSquare />,
};

export function RecordLayout({
  backTo,
  backLabel,
  title,
  subtitle,
  badges,
  icon,
  actions,
  headerFields,
  tabs,
  tab,
  onTabChange,
  record,
}: {
  backTo: '/companies' | '/contacts' | '/deals' | '/invoices';
  backLabel: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  headerFields?: ReactNode;
  tabs: RecordTab[];
  tab: string | undefined;
  onTabChange(tab: string): void;
  record?: OperatorRecord;
}) {
  const active = tabs.some((t) => t.value === tab) ? (tab as string) : (tabs[0]?.value ?? 'overview');
  return (
    <div className="flex flex-col gap-4 p-6">
      <Link
        to={backTo}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3" /> {backLabel}
      </Link>
      <header className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-start gap-3">
          {icon ? (
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-5">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight" data-testid="record-title">
                {title}
              </h1>
              {badges}
            </div>
            {subtitle ? <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div> : null}
          </div>
          <div className="flex items-center gap-3">
            <PresenceAvatars />
            {record ? <OperatorPanelSlot record={record} /> : null}
            {actions}
          </div>
        </div>
        <LockBanner />
        {headerFields ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-3 md:grid-cols-4">{headerFields}</div>
        ) : null}
      </header>
      <Tabs value={active} onValueChange={onTabChange}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`}>
              {t.icon}
              {t.label}
              {t.count !== undefined && t.count > 0 ? (
                <Badge variant="muted" className="ml-0.5 px-1.5">
                  {t.count}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <PanelBoundary resetKey={t.value}>{t.content}</PanelBoundary>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export function RecordSkeleton() {
  return (
    <div className="grid gap-4 p-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-28" />
      <Skeleton className="h-9 w-96" />
      <Skeleton className="h-64" />
    </div>
  );
}
