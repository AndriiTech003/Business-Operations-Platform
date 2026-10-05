import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { cn } from '@bop/ui';
import {
  Building,
  GitFork,
  KeyRound,
  type LucideIcon,
  Mail,
  Lock,
  Settings,
  Shield,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { Page, PageHeader } from '../../components/PageHeader';
import { PanelBoundary } from '../../components/PanelBoundary';
import { ApiTokensSettings, SecretsSettings } from './AccessSettings';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import { EmailTemplatesSettings } from './EmailTemplatesSettings';
import { PipelinesSettings } from './PipelinesSettings';
import { RolesOverview, TeamSettings } from './TeamSettings';
import { WorkspaceSettings } from './WorkspaceSettings';

const route = getRouteApi('/app/settings');

type Tab = 'team' | 'roles' | 'fields' | 'pipelines' | 'emails' | 'tokens' | 'secrets' | 'workspace';

const TABS: Array<{ value: Tab; label: string; icon: LucideIcon }> = [
  { value: 'team', label: 'Team', icon: Users },
  { value: 'roles', label: 'Roles', icon: Shield },
  { value: 'fields', label: 'Custom fields', icon: SlidersHorizontal },
  { value: 'pipelines', label: 'Pipelines', icon: GitFork },
  { value: 'emails', label: 'Email templates', icon: Mail },
  { value: 'tokens', label: 'API tokens', icon: KeyRound },
  { value: 'secrets', label: 'Secrets', icon: Lock },
  { value: 'workspace', label: 'Workspace', icon: Building },
];

export function SettingsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? 'team';
  return (
    <Page>
      <PageHeader
        icon={<Settings />}
        title="Settings"
        description="Team, data model, automation building blocks and access"
      />
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="flex shrink-0 flex-row flex-wrap gap-1 md:w-48 md:flex-col" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              data-testid={`settings-${t.value}`}
              aria-current={tab === t.value ? 'page' : undefined}
              onClick={() => void navigate({ to: '/settings', search: { tab: t.value }, replace: true })}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                tab === t.value && 'bg-accent font-medium text-foreground',
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <PanelBoundary resetKey={tab}>
            {tab === 'team' ? <TeamSettings /> : null}
            {tab === 'roles' ? <RolesOverview /> : null}
            {tab === 'fields' ? (
              <CustomFieldsSettings
                entity={search.entity ?? 'company'}
                onEntityChange={(entity) =>
                  void navigate({ to: '/settings', search: { tab: 'fields', entity }, replace: true })
                }
              />
            ) : null}
            {tab === 'pipelines' ? <PipelinesSettings /> : null}
            {tab === 'emails' ? <EmailTemplatesSettings /> : null}
            {tab === 'tokens' ? <ApiTokensSettings /> : null}
            {tab === 'secrets' ? <SecretsSettings /> : null}
            {tab === 'workspace' ? <WorkspaceSettings /> : null}
          </PanelBoundary>
        </div>
      </div>
    </Page>
  );
}
