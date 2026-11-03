import type { QueryClient } from '@tanstack/react-query';
import {
  type RouterHistory,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';

import { RouteError } from '@/components/RouteError';
import { Shell } from '@/components/Shell';
import type { Repositories } from '@/data/repositories';
import { requireAccess, requireSession } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { isActive, useSession } from '@/features/auth/session';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { OverviewPage } from '@/features/overview/OverviewPage';

export interface RouterContext {
  queryClient: QueryClient;
  repositories: Repositories;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: () => {
    if (isActive(useSession.getState().session)) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

/** Every back-office page sits under this layout: signed in, inside the shell. */
const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'staff',
  beforeLoad: requireSession,
  component: Shell,
  errorComponent: RouteError,
});

const dashboardRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/',
  beforeLoad: requireAccess('getAdminDashboard'),
  component: DashboardPage,
});

const myAccessRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/me',
  component: OverviewPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  staffRoute.addChildren([dashboardRoute, myAccessRoute]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, history, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
