import { useMemo } from 'react';
import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@bop/ui';
import { AppFlagsProvider } from '../../lib/flags';
import { RealtimeProvider, channels, useChannel } from '../../lib/realtime';
import { keys } from '../../lib/query-keys';
import { PanelBoundary } from '../../components/PanelBoundary';
import { useAuth, useMe } from '../auth';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

function GlobalSubscriptions() {
  const me = useMe();
  const qc = useQueryClient();
  useChannel(channels.approvals(me.tenant.id), {
    onMessage: () => {
      void qc.invalidateQueries({ queryKey: keys.approvals.all });
    },
  });
  return null;
}

function Shell() {
  const location = useLocation();
  const fullBleed = location.pathname.startsWith('/workflows/') || location.pathname.startsWith('/runs/');
  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main
          id="main"
          className={fullBleed ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto'}
          tabIndex={-1}
        >
          <PanelBoundary resetKey={location.pathname} title="This page crashed">
            <Outlet />
          </PanelBoundary>
        </main>
      </div>
      <GlobalSubscriptions />
    </div>
  );
}

export function AppLayout() {
  const { status, me } = useAuth();
  const location = useLocation();
  const redirect = useMemo(
    () => `${location.pathname}${location.searchStr ?? ''}`,
    [location.pathname, location.searchStr],
  );

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (status === 'anonymous' || me === null) return <Navigate to="/login" search={{ redirect }} replace />;

  return (
    <RealtimeProvider enabled key={me.tenant.id}>
      <AppFlagsProvider userId={me.user.id}>
        <Shell />
      </AppFlagsProvider>
    </RealtimeProvider>
  );
}
