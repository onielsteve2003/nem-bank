import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter } from '@tanstack/react-router';

import { Shell } from '@/components/Shell';
import type { Repositories } from '@/data/repositories';
import { OverviewPage } from '@/features/overview/OverviewPage';

export interface RouterContext {
  queryClient: QueryClient;
  repositories: Repositories;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Shell });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
});

const routeTree = rootRoute.addChildren([overviewRoute]);

export function createAppRouter(context: RouterContext) {
  return createRouter({ routeTree, context, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
