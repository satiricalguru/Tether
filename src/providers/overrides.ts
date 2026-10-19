import { browser } from 'wxt/browser';
import type { Capabilities } from './types';

/**
 * Capability downgrades learned at runtime (e.g. a server answered 400 to a
 * request with `tools`). Persisted per (endpoint, model) so the next request
 * picks the right tool-calling tier without failing first.
 */
export interface CapabilityOverrides {
  get(instanceId: string, model: string): Promise<Partial<Capabilities>>;
  set(instanceId: string, model: string, patch: Partial<Capabilities>): Promise<void>;
  clear(instanceId?: string): Promise<void>;
}

export const OVERRIDES_KEY = 'tether:capability-overrides';

type Store = Record<string, Partial<Capabilities>>;

const keyOf = (instanceId: string, model: string) => `${instanceId}::${model}`;

export function storageOverrides(): CapabilityOverrides {
  const load = async (): Promise<Store> => {
    const raw = (await browser.storage.local.get(OVERRIDES_KEY))[OVERRIDES_KEY];
    return raw && typeof raw === 'object' ? (raw as Store) : {};
  };
  return {
    async get(instanceId, model) {
      return (await load())[keyOf(instanceId, model)] ?? {};
    },
    async set(instanceId, model, patch) {
      const store = await load();
      const key = keyOf(instanceId, model);
      store[key] = { ...store[key], ...patch };
      await browser.storage.local.set({ [OVERRIDES_KEY]: store });
    },
    async clear(instanceId) {
      if (!instanceId) {
        await browser.storage.local.remove(OVERRIDES_KEY);
        return;
      }
      const store = Object.fromEntries(
        Object.entries(await load()).filter(([k]) => !k.startsWith(`${instanceId}::`)),
      );
      await browser.storage.local.set({ [OVERRIDES_KEY]: store });
    },
  };
}

export function memoryOverrides(): CapabilityOverrides & {
  store: Map<string, Partial<Capabilities>>;
} {
  const store = new Map<string, Partial<Capabilities>>();
  return {
    store,
    get: (i, m) => Promise.resolve(store.get(keyOf(i, m)) ?? {}),
    set: (i, m, patch) => {
      store.set(keyOf(i, m), { ...store.get(keyOf(i, m)), ...patch });
      return Promise.resolve();
    },
    clear: (i) => {
      for (const k of [...store.keys()]) if (!i || k.startsWith(`${i}::`)) store.delete(k);
      return Promise.resolve();
    },
  };
}
