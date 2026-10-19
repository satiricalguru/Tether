import { browser } from 'wxt/browser';
import { TetherError } from '@/lib/errors';
import type { HandlerMap } from '@/lib/messaging';
import { getSettings, updateSettings } from '@/lib/settings';
import { isBuiltin } from '@/providers/defaults';
import { normalizeBaseUrl } from '@/providers/http';
import { storageOverrides } from '@/providers/overrides';
import { ProviderRegistry, mergeDiscovery } from '@/providers/registry';
import type { ProviderConfig } from '@/providers/types';

export function createBackgroundRegistry(): ProviderRegistry {
  return new ProviderRegistry({
    getConfigs: async () => (await getSettings()).providers,
    overrides: storageOverrides(),
    hasHostPermission: (origin) => browser.permissions.contains({ origins: [`${origin}/*`] }),
  });
}

/** Run discovery and fold what answered into settings. */
export async function runDiscovery(registry: ProviderRegistry) {
  const results = await registry.discover();
  const { providers } = await getSettings();
  await updateSettings({ providers: mergeDiscovery(providers, results), discoveredAt: Date.now() });
  return results;
}

export function providerHandlers(registry: ProviderRegistry): HandlerMap {
  return {
    'bg:providers:status': () => registry.status(),
    'bg:providers:discover': () => runDiscovery(registry),
    'bg:providers:models': ({ instanceId }) => registry.models(instanceId),
    'bg:providers:all-models': () => registry.allModels(),
    'bg:providers:capabilities': ({ instanceId, model }) =>
      registry.capabilities(instanceId, model),
    'bg:providers:unload': async ({ instanceId, model }) => {
      const p = await registry.provider(instanceId);
      if (!p.unload) {
        throw new TetherError('E_UNSUPPORTED', `${p.label} can't unload models remotely`);
      }
      await p.unload(model);
      return undefined;
    },
    'bg:providers:save': async ({ config }) => {
      const { providers } = await getSettings();
      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(config.baseUrl);
      } catch {
        throw new TetherError('E_BAD_URL', `"${config.baseUrl}" is not a valid URL`);
      }
      const instanceId = config.instanceId || `custom-${crypto.randomUUID().slice(0, 8)}`;
      const existing = providers.find((p) => p.instanceId === instanceId);
      const next: ProviderConfig = {
        instanceId,
        kind: config.kind,
        label: config.label.trim() || baseUrl,
        baseUrl,
        enabled: config.enabled,
        // Omitted = keep the stored key; the UI never sees it.
        apiKey: config.apiKey ?? existing?.apiKey ?? '',
        useOpenAICompat: config.useOpenAICompat,
      };
      await updateSettings({
        providers: existing
          ? providers.map((p) => (p.instanceId === instanceId ? next : p))
          : [...providers, next],
      });
      registry.invalidate(instanceId);
      return registry.status();
    },
    'bg:providers:remove': async ({ instanceId }) => {
      if (isBuiltin(instanceId)) {
        throw new TetherError('E_BUILTIN', 'Built-in providers can be disabled, not removed');
      }
      const s = await getSettings();
      await updateSettings({
        providers: s.providers.filter((p) => p.instanceId !== instanceId),
        ...(s.selection.instanceId === instanceId
          ? { selection: { instanceId: '', model: '' } }
          : {}),
      });
      registry.invalidate(instanceId);
      return registry.status();
    },
    'bg:providers:reset-overrides': async ({ instanceId }) => {
      await storageOverrides().clear(instanceId);
      registry.invalidate(instanceId);
      return undefined;
    },
  };
}
