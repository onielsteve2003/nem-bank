import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type ApprovalRequest = Schema<'ApprovalRequest'>;
export type ApprovalStatus = Schema<'MakerCheckerStatus'>;

export const approvalKeys = {
  list: (status: ApprovalStatus) => ['approvals', 'list', status] as const,
  detail: (id: string) => ['approvals', 'approval', id] as const,
};

export function useApprovals(status: ApprovalStatus) {
  const { approvals } = useRepositories();
  return useInfiniteQuery({
    queryKey: approvalKeys.list(status),
    queryFn: ({ pageParam, signal }) =>
      approvals.list({ query: { status, cursor: pageParam } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useApproval(approvalId: string) {
  const { approvals } = useRepositories();
  return useQuery({
    queryKey: approvalKeys.detail(approvalId),
    queryFn: ({ signal }) => approvals.get({ path: { approval_id: approvalId } }, { signal }),
  });
}

/** An approval changes other pages too (a customer, the config, a dispute), so refresh them. */
function useOnDecided(approvalId: string) {
  const queryClient = useQueryClient();
  return (approval: ApprovalRequest) => {
    queryClient.setQueryData(approvalKeys.detail(approvalId), approval);
    for (const key of ['approvals', 'customers', 'config', 'disputes', 'audit', 'ledger']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useApprove(approvalId: string) {
  const { approvals } = useRepositories();
  const onSuccess = useOnDecided(approvalId);
  return useMutation({
    mutationFn: (idempotencyKey: string) =>
      approvals.approve({ path: { approval_id: approvalId }, idempotencyKey }),
    onSuccess,
  });
}

export function useReject(approvalId: string) {
  const { approvals } = useRepositories();
  const onSuccess = useOnDecided(approvalId);
  return useMutation({
    mutationFn: (reason: string) =>
      approvals.reject({ path: { approval_id: approvalId }, body: { reason } }),
    onSuccess,
  });
}
