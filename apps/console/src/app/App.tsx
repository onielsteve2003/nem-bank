import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';

import { isApiError } from '@/data/errors';
import { RepositoryProvider, useRepositories } from '@/data/provider';
import { useSession } from '@/features/auth/session';

import { createAppRouter } from './router';

// A 401 anywhere means the session is gone at the bank; the shell then sends the
// staff member to login and back.
const onUnauthorized = (error: unknown) => {
  if (isApiError(error, 'unauthorized')) useSession.getState().signOut();
};

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onUnauthorized }),
    mutationCache: new MutationCache({ onError: onUnauthorized }),
    defaultOptions: {
      // Staff data changes under them (queues, holds); keep it fresh but avoid refetch storms.
      queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

function AppRouter({ queryClient }: { queryClient: QueryClient }) {
  const repositories = useRepositories();
  const [router] = useState(() => createAppRouter({ queryClient, repositories }));
  return <RouterProvider router={router} />;
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <RepositoryProvider>
        <AppRouter queryClient={queryClient} />
      </RepositoryProvider>
    </QueryClientProvider>
  );
}
