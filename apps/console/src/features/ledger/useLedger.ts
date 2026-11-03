import type { CurrencyCode, Schema } from '@nem/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type LedgerAccount = Schema<'LedgerAccount'>;
export type JournalEntry = Schema<'JournalEntry'>;
export type EntryKind = Schema<'JournalEntryKind'>;

export interface EntryFilters {
  kind?: EntryKind;
  reference?: string;
  from?: string;
  to?: string;
}

export interface AccountFilters {
  owner?: Schema<'LedgerOwnerType'>;
  currency?: CurrencyCode;
}

export const ledgerKeys = {
  entries: (f: EntryFilters) => ['ledger', 'entries', f] as const,
  entry: (id: string) => ['ledger', 'entry', id] as const,
  accounts: (f: AccountFilters) => ['ledger', 'accounts', f] as const,
  accountIndex: ['ledger', 'account-index'] as const,
  postings: (id: string) => ['ledger', 'postings', id] as const,
  trialBalance: (asOf: string | undefined) => ['ledger', 'trial-balance', asOf ?? 'now'] as const,
  reconciliation: (date: string) => ['ledger', 'reconciliation', date] as const,
};

const nextCursor = (last: { page: Schema<'PageInfo'> }) => last.page.next_cursor ?? undefined;

export function useJournalEntries(filters: EntryFilters) {
  const { ledger } = useRepositories();
  return useInfiniteQuery({
    queryKey: ledgerKeys.entries(filters),
    queryFn: ({ pageParam, signal }) =>
      ledger.listEntries({ query: { ...filters, cursor: pageParam } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function useJournalEntry(entryId: string) {
  const { ledger } = useRepositories();
  return useQuery({
    queryKey: ledgerKeys.entry(entryId),
    queryFn: ({ signal }) => ledger.getEntry({ path: { entry_id: entryId } }, { signal }),
  });
}

export function useLedgerAccounts({ owner, currency }: AccountFilters) {
  const { ledger } = useRepositories();
  return useInfiniteQuery({
    queryKey: ledgerKeys.accounts({ owner, currency }),
    queryFn: ({ pageParam, signal }) =>
      ledger.listAccounts(
        {
          query: {
            ...(owner && { owner_type: owner }),
            ...(currency && { currency }),
            cursor: pageParam,
            limit: 50,
          },
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** Every ledger account by ID, so postings can show names (the bank has a few dozen). */
export function useAccountIndex() {
  const { ledger } = useRepositories();
  return useQuery({
    queryKey: ledgerKeys.accountIndex,
    queryFn: async ({ signal }) => {
      const index = new Map<string, LedgerAccount>();
      let cursor: string | undefined;
      do {
        const page = await ledger.listAccounts({ query: { cursor, limit: 100 } }, { signal });
        for (const a of page.data) index.set(a.id, a);
        cursor = page.page.next_cursor ?? undefined;
      } while (cursor);
      return index;
    },
    staleTime: 60_000,
  });
}

export function usePostings(accountId: string) {
  const { ledger } = useRepositories();
  return useInfiniteQuery({
    queryKey: ledgerKeys.postings(accountId),
    queryFn: ({ pageParam, signal }) =>
      ledger.listPostings(
        { path: { ledger_account_id: accountId }, query: { cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useTrialBalance(asOf: string | undefined) {
  const { ledger } = useRepositories();
  return useQuery({
    queryKey: ledgerKeys.trialBalance(asOf),
    queryFn: ({ signal }) =>
      ledger.trialBalance({ query: asOf ? { as_of: asOf } : {} }, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useReconciliation(date: string) {
  const { ledger } = useRepositories();
  return useQuery({
    queryKey: ledgerKeys.reconciliation(date),
    queryFn: ({ signal }) => ledger.reconciliation({ query: { date } }, { signal }),
    retry: false,
  });
}
