import type { Schema } from '@nem/contracts';
import { useQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data';
import { queryKeys } from '@/lib/query';

const PAGE = 100;

/**
 * Every completed transaction in a ready statement's period, oldest first,
 * the order a statement reads in. Pages are fetched until the cursor runs out:
 * a statement that silently stopped at page one would be wrong.
 */
export function useStatementLines(statement: Schema<'Statement'> | undefined) {
  const repos = useRepositories();
  const query = statement && {
    account_id: statement.account_id,
    status: 'completed' as const,
    from: statement.period_from,
    to: statement.period_to,
    limit: PAGE,
  };
  return useQuery({
    queryKey: [...queryKeys.op('transactions', 'list', { query }), 'statement'],
    enabled: statement?.status === 'ready',
    queryFn: async ({ signal }) => {
      const lines: Schema<'Transaction'>[] = [];
      let cursor: string | null = null;
      do {
        const page = await repos.transactions.list(
          { query: cursor ? { ...query!, cursor } : query! },
          { signal },
        );
        lines.push(...page.data);
        cursor = page.page.next_cursor ?? null;
      } while (cursor);
      return lines.reverse();
    },
  });
}
