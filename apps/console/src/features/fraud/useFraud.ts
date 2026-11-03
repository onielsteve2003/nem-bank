import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type FraudCase = Schema<'FraudCase'>;
export type FraudDecision = Schema<'FraudDecisionRequest'>;
/** `active` = open and in review: the work still to do. */
export type FraudFilter = 'active' | 'released' | 'rejected';

export const fraudKeys = {
  queue: (filter: FraudFilter, mine: boolean) => ['fraud', 'queue', filter, mine] as const,
  detail: (id: string) => ['fraud', 'case', id] as const,
};

export function useFraudQueue(filter: FraudFilter, mine: boolean) {
  const { fraud } = useRepositories();
  return useInfiniteQuery({
    queryKey: fraudKeys.queue(filter, mine),
    queryFn: ({ pageParam, signal }) =>
      fraud.list(
        {
          query: {
            ...(filter !== 'active' && { status: filter }),
            ...(mine && { assigned_to_me: true }),
            cursor: pageParam,
          },
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useFraudCase(caseId: string) {
  const { fraud } = useRepositories();
  return useQuery({
    queryKey: fraudKeys.detail(caseId),
    queryFn: ({ signal }) => fraud.get({ path: { case_id: caseId } }, { signal }),
  });
}

function useOnCaseChange(caseId: string) {
  const queryClient = useQueryClient();
  return (updated: FraudCase) => {
    queryClient.setQueryData(fraudKeys.detail(caseId), updated);
    void queryClient.invalidateQueries({ queryKey: ['fraud', 'queue'] });
  };
}

export function useAssignFraudCase(caseId: string) {
  const { fraud } = useRepositories();
  const onSuccess = useOnCaseChange(caseId);
  return useMutation({
    mutationFn: () => fraud.assign({ path: { case_id: caseId } }),
    onSuccess,
  });
}

/** One idempotency key per decision attempt, so a retry can never decide twice. */
export function useDecideFraudCase(caseId: string) {
  const { fraud } = useRepositories();
  const onSuccess = useOnCaseChange(caseId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: FraudDecision; idempotencyKey: string }) =>
      fraud.decide({ path: { case_id: caseId }, body, idempotencyKey }),
    onSuccess: (updated) => {
      onSuccess(updated);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
