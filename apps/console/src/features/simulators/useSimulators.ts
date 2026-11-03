import type { Schema } from '@nem/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type CardTransaction = Schema<'CardTransaction'>;
export type ChargeRequest = Schema<'SimulatedChargeRequest'>;
export type BankPartnerSettings = Schema<'BankPartnerSimulator'>;

const bankPartnerKey = ['simulators', 'bank-partner'] as const;

/** A charge moves a customer's balance and the ledger, so those pages refresh. */
function useRefreshBalances() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['customers', 'ledger', 'dashboard', 'audit']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useChargeCard() {
  const { simulators } = useRepositories();
  const onSuccess = useRefreshBalances();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: ChargeRequest; idempotencyKey: string }) =>
      simulators.charge({ body, idempotencyKey }),
    onSuccess,
  });
}

export function useSettleCharge() {
  const { simulators } = useRepositories();
  const onSuccess = useRefreshBalances();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'capture' | 'reverse' }) => {
      const input = {
        path: { authorization_id: id },
        body: {},
        idempotencyKey: crypto.randomUUID(),
      };
      return action === 'capture' ? simulators.capture(input) : simulators.reverse(input);
    },
    onSuccess,
  });
}

export function useBankPartner() {
  const { simulators } = useRepositories();
  return useQuery({
    queryKey: bankPartnerKey,
    queryFn: ({ signal }) => simulators.getBankPartner(undefined, { signal }),
  });
}

export function useSaveBankPartner() {
  const { simulators } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BankPartnerSettings) => simulators.setBankPartner({ body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(bankPartnerKey, saved);
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
