import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type KycQueueStatus = Schema<'KycSubmission'>['status'];
export type KycDecision = Schema<'KycDecisionRequest'>;

export const kycKeys = {
  queue: (status: KycQueueStatus) => ['kyc', 'queue', status] as const,
  review: (id: string) => ['kyc', 'review', id] as const,
};

export function useKycQueue(status: KycQueueStatus) {
  const { kyc } = useRepositories();
  return useInfiniteQuery({
    queryKey: kycKeys.queue(status),
    queryFn: ({ pageParam, signal }) =>
      kyc.list({ query: { status, cursor: pageParam } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useKycReview(submissionId: string) {
  const { kyc } = useRepositories();
  return useQuery({
    queryKey: kycKeys.review(submissionId),
    queryFn: ({ signal }) => kyc.get({ path: { submission_id: submissionId } }, { signal }),
    // Document links are signed for five minutes; refresh them before they lapse.
    refetchInterval: 4 * 60_000,
  });
}

export function useDecideKyc(submissionId: string) {
  const { kyc } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: KycDecision) => kyc.decide({ path: { submission_id: submissionId }, body }),
    onSuccess: (review) => {
      queryClient.setQueryData(kycKeys.review(submissionId), review);
      void queryClient.invalidateQueries({ queryKey: ['kyc', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
