import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

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
