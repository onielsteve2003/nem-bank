import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type AdminDispute = Schema<'AdminDispute'>;
export type DisputeDecision = Schema<'DisputeDecisionRequest'>;
export type ApprovalRequest = Schema<'ApprovalRequest'>;
/** `active` = submitted, under review or waiting on the customer: still open. */
export type DisputeFilter = 'active' | 'resolved_refunded' | 'resolved_declined';

export const disputeKeys = {
  queue: (filter: DisputeFilter) => ['disputes', 'queue', filter] as const,
  detail: (id: string) => ['disputes', 'dispute', id] as const,
};

export function useDisputeQueue(filter: DisputeFilter) {
  const { disputes } = useRepositories();
  return useInfiniteQuery({
    queryKey: disputeKeys.queue(filter),
    queryFn: ({ pageParam, signal }) =>
      disputes.list(
        { query: { ...(filter !== 'active' && { status: filter }), cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useDispute(disputeId: string) {
  const { disputes } = useRepositories();
  return useQuery({
    queryKey: disputeKeys.detail(disputeId),
    queryFn: ({ signal }) => disputes.get({ path: { dispute_id: disputeId } }, { signal }),
  });
}

/** A refund above the checker threshold comes back as a 202 approval request instead. */
export const isApproval = (result: AdminDispute | ApprovalRequest): result is ApprovalRequest =>
  'action' in result;

export function useDecideDispute(disputeId: string) {
  const { disputes } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: DisputeDecision; idempotencyKey: string }) =>
      disputes.decide({ path: { dispute_id: disputeId }, body, idempotencyKey }),
    onSuccess: (result) => {
      if (!isApproval(result)) queryClient.setQueryData(disputeKeys.detail(disputeId), result);
      else void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(disputeId) });
      void queryClient.invalidateQueries({ queryKey: ['disputes', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
