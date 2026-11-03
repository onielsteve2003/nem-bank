import type { StaffRole } from '@nem/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { useState } from 'react';

import { createQueryClient } from '@/app/App';
import { createAppRouter } from '@/app/router';
import { switchDemoRole } from '@/data/mock/auth';
import { createMockState } from '@/data/mock/state';
import { RepositoryProvider, useRepositories } from '@/data/provider';
import { useSession } from '@/features/auth/session';

function Harness({ path }: { path: string }) {
  const repositories = useRepositories();
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() =>
    createAppRouter({ queryClient, repositories }, createMemoryHistory({ initialEntries: [path] })),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

/** The whole console at `path`, signed in as the seeded staff member with `role`. */
export function renderApp(path: string, role: StaffRole = 'admin') {
  const state = createMockState();
  useSession.getState().signIn(switchDemoRole(state, role));
  const mock = { latencyMs: 0, state };
  return {
    state,
    ...render(
      <RepositoryProvider mock={mock}>
        <Harness path={path} />
      </RepositoryProvider>,
    ),
  };
}
