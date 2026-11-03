import type { Schema } from '@nem/contracts';
import { keepPreviousData, useInfiniteQuery, useMutation } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type AuditEntry = Schema<'AuditEntry'>;
export type AuditVerification = Schema<'AuditVerification'>;

export interface AuditFilters {
  action?: string;
  resource_id?: string;
  from?: string;
  to?: string;
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (filters: AuditFilters) => ['audit', 'list', filters] as const,
};

export function useAuditLog(filters: AuditFilters) {
  const { audit } = useRepositories();
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      audit.list({ query: { ...filters, cursor: pageParam, limit: 25 } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Recomputes the whole chain on the server and reports the first entry that doesn't match. */
export function useVerifyAudit() {
  const { audit } = useRepositories();
  return useMutation({ mutationFn: () => audit.verify({ body: {} }) });
}
