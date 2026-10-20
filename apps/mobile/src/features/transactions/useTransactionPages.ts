import { useInfiniteQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data';
import { queryKeys } from '@/lib/query';

import type { toQuery } from './filters';

type Query = ReturnType<typeof toQuery>;

/**
 * Cursor pages of the transaction list (ACC-5). Keyed under
 * ['transactions', 'list', query, 'pages'] so every transactions invalidation
 * (realtime, a new transfer) refreshes it with the rest of the domain.
 */
export function useTransactionPages(query: Query) {
  const repos = useRepositories();
  return useInfiniteQuery({
    queryKey: [...queryKeys.op('transactions', 'list', { query }), 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      repos.transactions.list(
        { query: pageParam ? { ...query, cursor: pageParam } : query },
        { signal },
      ),
    getNextPageParam: (last) => last.page.next_cursor ?? null,
    select: (data) => data.pages.flatMap((p) => p.data),
  });
}
