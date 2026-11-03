import { useQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export const staffMeKey = ['staff', 'me'] as const;

export function useStaffMe() {
  const { auth } = useRepositories();
  return useQuery({
    queryKey: staffMeKey,
    queryFn: ({ signal }) => auth.me(undefined, { signal }),
  });
}
