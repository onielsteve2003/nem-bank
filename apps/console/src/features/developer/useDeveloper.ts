import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useCallback } from 'react';

import { problem } from '@/data/errors';
import { useDemoControls, useRepositories } from '@/data/provider';

import { browserDevice, useDeveloperSession } from './developerSession';

/** Real API only: signs the browser in as a business customer, on its own device. */
export function useDeveloperLogin() {
  const { developerAuth } = useRepositories();
  const signIn = useDeveloperSession((s) => s.signIn);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { identifier: string; password: string }) =>
      developerAuth.login({ body: { ...input, device: browserDevice() } }),
    onSuccess: (session) => {
      queryClient.clear();
      signIn(session);
    },
  });
}

/** Ends the portal session at the bank, then here even if that call fails. */
export function useDeveloperSignOut() {
  const { developerAuth } = useRepositories();
  const signOut = useDeveloperSession((s) => s.signOut);
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await developerAuth.logout({ body: { all_devices: false } });
    } catch {
      // The session is forgotten here either way.
    } finally {
      signOut();
      queryClient.clear();
    }
  }, [developerAuth, signOut, queryClient]);
}

/**
 * Turns the customer's PIN into a single-use step-up token for creating an API key.
 * The demo checks its own PIN; the real API starts a step-up and verifies the PIN.
 */
export function useDeveloperStepUp(): (pin: string) => Promise<string> {
  const demo = useDemoControls();
  const { developerAuth } = useRepositories();
  return useCallback(
    async (pin: string) => {
      if (demo) {
        const token = demo.developerStepUp(pin);
        if (!token) throw problem(403, 'wrong_pin', 'That PIN is not right.');
        return token;
      }
      const challenge = await developerAuth.startStepUp({ body: { purpose: 'api_key' } });
      if (!challenge.methods.includes('pin')) {
        throw problem(409, 'pin_not_set', 'Set a transaction PIN in the Nem app first');
      }
      const result = await developerAuth.verifyStepUp({
        path: { step_up_id: challenge.step_up_id },
        body: { pin },
      });
      return result.step_up_token;
    },
    [demo, developerAuth],
  );
}

export type ApiKey = Schema<'ApiKey'>;
export type ApiKeyScope = Schema<'ApiKeyScope'>;
export type WebhookEndpoint = Schema<'WebhookEndpoint'>;
export type WebhookEventType = Schema<'WebhookEventType'>;
export type WebhookDelivery = Schema<'WebhookDelivery'>;
export type DeliveryStatus = Schema<'WebhookDeliveryStatus'>;

export const developerKeys = {
  keys: ['developer', 'keys'] as const,
  endpoints: ['developer', 'endpoints'] as const,
  endpoint: (id: string) => ['developer', 'endpoint', id] as const,
  deliveries: (id: string, status?: DeliveryStatus) =>
    ['developer', 'deliveries', id, status ?? 'all'] as const,
};

export function useApiKeys() {
  const { developer } = useRepositories();
  return useQuery({
    queryKey: developerKeys.keys,
    queryFn: ({ signal }) => developer.listKeys(undefined, { signal }),
  });
}

export function useCreateApiKey() {
  const { developer } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[]; stepUpToken: string }) =>
      developer.createKey({
        body: { name: input.name, scopes: input.scopes },
        stepUpToken: input.stepUpToken,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: developerKeys.keys }),
  });
}

export function useRevokeApiKey() {
  const { developer } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => developer.revokeKey({ path: { key_id: keyId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: developerKeys.keys }),
  });
}

export function useEndpoints() {
  const { developer } = useRepositories();
  return useQuery({
    queryKey: developerKeys.endpoints,
    queryFn: ({ signal }) => developer.listEndpoints(undefined, { signal }),
  });
}

export function useEndpoint(endpointId: string) {
  const { developer } = useRepositories();
  return useQuery({
    queryKey: developerKeys.endpoint(endpointId),
    queryFn: ({ signal }) =>
      developer.getEndpoint({ path: { endpoint_id: endpointId } }, { signal }),
  });
}

export function useDeliveries(endpointId: string, status?: DeliveryStatus) {
  const { developer } = useRepositories();
  return useInfiniteQuery({
    queryKey: developerKeys.deliveries(endpointId, status),
    queryFn: ({ pageParam, signal }) =>
      developer.listDeliveries(
        { path: { endpoint_id: endpointId }, query: { status, cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Every write to webhooks refreshes the endpoint list, the endpoint and its log. */
function useRefreshWebhooks() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['endpoints', 'endpoint', 'deliveries']) {
      void queryClient.invalidateQueries({ queryKey: ['developer', key] });
    }
  };
}

export function useCreateEndpoint() {
  const { developer } = useRepositories();
  const onSuccess = useRefreshWebhooks();
  return useMutation({
    mutationFn: (body: { url: string; description?: string; events: WebhookEventType[] }) =>
      developer.createEndpoint({ body }),
    onSuccess,
  });
}

export function useEndpointActions(endpointId: string) {
  const { developer } = useRepositories();
  const onSuccess = useRefreshWebhooks();
  const path = { endpoint_id: endpointId };
  return {
    setStatus: useMutation({
      mutationFn: (status: WebhookEndpoint['status']) =>
        developer.updateEndpoint({ path, body: { status } }),
      onSuccess,
    }),
    rotate: useMutation({ mutationFn: () => developer.rotateSecret({ path }), onSuccess }),
    test: useMutation({ mutationFn: () => developer.sendTest({ path }), onSuccess }),
    remove: useMutation({ mutationFn: () => developer.deleteEndpoint({ path }), onSuccess }),
    replay: useMutation({
      mutationFn: (deliveryId: string) => developer.replay({ path: { delivery_id: deliveryId } }),
      onSuccess,
    }),
  };
}
