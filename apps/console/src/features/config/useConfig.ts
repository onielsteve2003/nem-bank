import type { Schema } from '@nem/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type BankConfig = Schema<'BankConfig'>;
export type ConfigChange = Schema<'ConfigChangeRequest'>;
export type ConfigSection = ConfigChange['section'];
export type FeatureFlag = Schema<'FeatureFlag'>;

export const configKeys = {
  config: ['config'] as const,
  flags: ['feature-flags'] as const,
};

export function useBankConfig() {
  const { config } = useRepositories();
  return useQuery({
    queryKey: configKeys.config,
    queryFn: ({ signal }) => config.get(undefined, { signal }),
  });
}

/** Proposes a change; it applies only once a second staff member approves it (ADM-10). */
export function useRequestConfigChange() {
  const { config } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfigChange) => config.requestChange({ body }),
    onError: () => void queryClient.invalidateQueries({ queryKey: configKeys.config }),
  });
}

export function useFeatureFlags() {
  const { config } = useRepositories();
  return useQuery({
    queryKey: configKeys.flags,
    queryFn: ({ signal }) => config.listFlags(undefined, { signal }),
  });
}

export function useUpdateFlag() {
  const { config } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, enabled, reason }: { key: string; enabled: boolean; reason: string }) =>
      config.updateFlag({ path: { flag_key: key }, body: { enabled, reason } }),
    onSuccess: (flag) =>
      queryClient.setQueryData(configKeys.flags, (old: { data: FeatureFlag[] } | undefined) =>
        old ? { data: old.data.map((f) => (f.key === flag.key ? flag : f)) } : old,
      ),
  });
}
