import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sendMessage } from '@/lib/messaging';
import type { MessageRequest } from '@/lib/protocol';

export const providerKeys = {
  status: ['providers', 'status'] as const,
  allModels: ['providers', 'all-models'] as const,
  models: (instanceId: string) => ['providers', 'models', instanceId] as const,
};

export function useProviderStatus(refetchInterval: number | false = 15_000) {
  return useQuery({
    queryKey: providerKeys.status,
    queryFn: () => sendMessage('bg:providers:status'),
    refetchInterval,
  });
}

export function useAllModels() {
  return useQuery({
    queryKey: providerKeys.allModels,
    queryFn: () => sendMessage('bg:providers:all-models'),
    refetchInterval: 30_000,
  });
}

export function useModels(instanceId: string, enabled = true) {
  return useQuery({
    queryKey: providerKeys.models(instanceId),
    queryFn: () => sendMessage('bg:providers:models', { instanceId }),
    enabled,
  });
}

/** Invalidate everything provider-related after a change. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['providers'] });
}

export function useDiscover() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => sendMessage('bg:providers:discover'),
    onSettled: invalidate,
  });
}

export function useSaveProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (config: MessageRequest<'bg:providers:save'>['config']) =>
      sendMessage('bg:providers:save', { config }),
    onSettled: invalidate,
  });
}

export function useRemoveProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (instanceId: string) => sendMessage('bg:providers:remove', { instanceId }),
    onSettled: invalidate,
  });
}

export function useResetOverrides() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (instanceId: string) => sendMessage('bg:providers:reset-overrides', { instanceId }),
    onSettled: invalidate,
  });
}

export function useUnloadModel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { instanceId: string; model: string }) => sendMessage('bg:providers:unload', v),
    onSettled: invalidate,
  });
}
