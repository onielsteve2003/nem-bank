import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';

import { RepositoryProvider, useRepositories } from '@/data/provider';

import { createAppRouter } from './router';

export function createQueryClient() {
  return new QueryClient({
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
