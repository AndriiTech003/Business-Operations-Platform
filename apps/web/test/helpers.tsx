import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { TooltipProvider } from '@bop/ui';
import type { MeDto } from '@bop/contracts';
import { AuthProvider } from '../src/app/auth';

export const ME: MeDto = {
  user: { id: '00000000-0000-4000-8000-000000000001', name: 'Dana Owner', email: 'demo@demo.dev' },
  tenant: {
    id: 't1',
    slug: 'acme',
    name: 'Acme',
    settings: { timezone: 'UTC', currency: 'USD', invoicePrefix: 'INV', emailsPerMinute: 60, maxConcurrentSteps: 4 },
  },
  role: 'owner',
  scopes: ['records:read', 'records:write', 'workflows:read', 'workflows:write', 'admin'],
  tenants: [],
};

export function renderWithProviders(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  qc.setQueryData(['members'], [{ id: ME.user.id, name: ME.user.name, email: ME.user.email, role: 'owner' }]);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <AuthProvider initial={ME}>
        <TooltipProvider>{children}</TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
  return { qc, ...render(ui, { wrapper: Wrapper }) };
}
