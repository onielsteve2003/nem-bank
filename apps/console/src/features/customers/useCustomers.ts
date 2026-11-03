import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export const customerKeys = {
  search: (q: string) => ['customers', 'search', q] as const,
  detail: (userId: string) => ['customers', 'detail', userId] as const,
};

export function useCustomerSearch(q: string) {
  const { customers } = useRepositories();
  return useInfiniteQuery({
    queryKey: customerKeys.search(q),
    queryFn: ({ pageParam, signal }) =>
      customers.search({ query: { q, cursor: pageParam } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    enabled: q.trim().length >= 2,
    placeholderData: keepPreviousData,
  });
}

export function useCustomer360(userId: string) {
  const { customers } = useRepositories();
  return useQuery({
    queryKey: customerKeys.detail(userId),
    queryFn: ({ signal }) => customers.get({ path: { user_id: userId } }, { signal }),
  });
}

export function useAddNote(userId: string) {
  const { customers } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => customers.addNote({ path: { user_id: userId }, body: { body } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customerKeys.detail(userId) }),
  });
}

export function useFreeze(userId: string) {
  const { customers } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      customers.freeze({ path: { user_id: userId }, body: { reason } }),
    onSuccess: (view) => {
      queryClient.setQueryData(customerKeys.detail(userId), view);
      // Search results show the status too.
      void queryClient.invalidateQueries({ queryKey: ['customers', 'search'] });
    },
  });
}

export function useRequestUnfreeze(userId: string) {
  const { customers } = useRepositories();
  return useMutation({
    mutationFn: (reason: string) =>
      customers.requestUnfreeze({ path: { user_id: userId }, body: { reason } }),
  });
}
