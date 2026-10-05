import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { tableSearchSchema } from '../lib/table';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './LoginPage';
import { NotFound, RouteError, RoutePending } from './NotFound';
import {
  approvalsSearch,
  builderSearch,
  dealsSearch,
  loginSearch,
  recordSearch,
  reportsSearch,
  runSearch,
  runsSearch,
  settingsSearch,
  tasksSearch,
} from './search';

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearch,
  component: LoginPage,
});
const publicInvoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/invoices/$token',
  component: lazyRouteComponent(() => import('../features/invoices/PublicInvoicePage'), 'PublicInvoicePage'),
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppLayout });

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/deals' });
  },
});

const companiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/companies',
  validateSearch: tableSearchSchema,
  component: lazyRouteComponent(() => import('../features/companies/CompaniesPage'), 'CompaniesPage'),
});
const companyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/companies/$id',
  validateSearch: recordSearch,
  component: lazyRouteComponent(() => import('../features/companies/CompanyPage'), 'CompanyPage'),
});
const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/contacts',
  validateSearch: tableSearchSchema,
  component: lazyRouteComponent(() => import('../features/contacts/ContactsPage'), 'ContactsPage'),
});
const contactRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/contacts/$id',
  validateSearch: recordSearch,
  component: lazyRouteComponent(() => import('../features/contacts/ContactPage'), 'ContactPage'),
});
const dealsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deals',
  validateSearch: dealsSearch,
  component: lazyRouteComponent(() => import('../features/deals/DealsPage'), 'DealsPage'),
});
const dealRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deals/$id',
  validateSearch: recordSearch,
  component: lazyRouteComponent(() => import('../features/deals/DealPage'), 'DealPage'),
});
const invoicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices',
  validateSearch: tableSearchSchema,
  component: lazyRouteComponent(() => import('../features/invoices/InvoicesPage'), 'InvoicesPage'),
});
const invoiceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices/$id',
  validateSearch: recordSearch,
  component: lazyRouteComponent(() => import('../features/invoices/InvoicePage'), 'InvoicePage'),
});
const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/tasks',
  validateSearch: tasksSearch,
  component: lazyRouteComponent(() => import('../features/tasks/TasksPage'), 'TasksPage'),
});
const workflowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workflows',
  component: lazyRouteComponent(() => import('../features/workflows/WorkflowsPage'), 'WorkflowsPage'),
});
const builderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workflows/$id',
  validateSearch: builderSearch,
  component: lazyRouteComponent(() => import('../features/workflows/builder/BuilderPage'), 'BuilderPage'),
});
const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  validateSearch: runsSearch,
  component: lazyRouteComponent(() => import('../features/workflows/runs/RunsPage'), 'RunsPage'),
});
const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs/$id',
  validateSearch: runSearch,
  component: lazyRouteComponent(() => import('../features/workflows/runs/RunDetailPage'), 'RunDetailPage'),
});
const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/approvals',
  validateSearch: approvalsSearch,
  component: lazyRouteComponent(() => import('../features/approvals/ApprovalsPage'), 'ApprovalsPage'),
});
const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports',
  validateSearch: reportsSearch,
  component: lazyRouteComponent(() => import('../features/reports/ReportsPage'), 'ReportsPage'),
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  validateSearch: settingsSearch,
  component: lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  publicInvoiceRoute,
  appRoute.addChildren([
    indexRoute,
    companiesRoute,
    companyRoute,
    contactsRoute,
    contactRoute,
    dealsRoute,
    dealRoute,
    invoicesRoute,
    invoiceRoute,
    tasksRoute,
    workflowsRoute,
    builderRoute,
    runsRoute,
    runRoute,
    approvalsRoute,
    reportsRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 150,
    defaultErrorComponent: RouteError,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
