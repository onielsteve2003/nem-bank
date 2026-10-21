import { useInfiniteQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data';
import { queryKeys } from '@/lib/query';

/**
 * Cursor pages of conversion history (FX-4). Keyed under ['fx', 'listConversions']
 * so a new conversion, which invalidates the fx domain, refreshes it.
 */
export function useConversionPages() {
  const repos = useRepositories();
  return useInfiniteQuery({
    queryKey: [...queryKeys.op('fx', 'listConversions', {}), 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      repos.fx.listConversions({ query: pageParam ? { cursor: pageParam } : {} }, { signal }),
    getNextPageParam: (last) => last.page.next_cursor ?? null,
    select: (data) => data.pages.flatMap((p) => p.data),
  });
}
