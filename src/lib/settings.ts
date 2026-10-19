import { browser } from 'wxt/browser';
import { BUILTIN_PROVIDERS, sanitizeProviders } from '@/providers/defaults';
import type { ProviderConfig } from '@/providers/types';

/**
 * User settings, persisted in `chrome.storage.local` under one key.
 *
 * Stored values are always merged over `DEFAULT_SETTINGS`, so adding a field
 * in a later release never needs a migration; only renames/reshapes do, and
 * those go in `MIGRATIONS` keyed by the version they upgrade *from*.
 */

export type Theme = 'system' | 'light' | 'dark';

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface Settings {
  schemaVersion: number;
  theme: Theme;
  providers: ProviderConfig[];
  /** The model the composer uses; empty strings = nothing chosen yet. */
  selection: ModelSelection;
  /** When first-run discovery last completed (0 = never). */
  discoveredAt: number;
}

export const SETTINGS_KEY = 'tether:settings';
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_VERSION,
  theme: 'system',
  providers: BUILTIN_PROVIDERS.map((p) => ({ ...p })),
  selection: { instanceId: '', model: '' },
  discoveredAt: 0,
};

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration> = {};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge `patch` over `base`. Objects merge recursively; arrays and primitives
 * replace. Keys absent from `base` are dropped, as are values whose type
 * disagrees with the default, so corrupted storage can't produce an invalid
 * Settings object.
 */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, baseValue] of Object.entries(base)) {
    if (!(key in patch)) continue;
    const next = patch[key];
    if (next === undefined) continue;
    if (isPlainObject(baseValue)) {
      out[key] = mergeDeep(baseValue, next);
    } else if (Array.isArray(baseValue)) {
      if (Array.isArray(next)) out[key] = next;
    } else if (baseValue === null || typeof baseValue === typeof next) {
      out[key] = next;
    }
  }
  return out as T;
}

export function migrate(raw: unknown): Settings {
  if (!isPlainObject(raw)) return structuredClone(DEFAULT_SETTINGS);
  let current = raw;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0;
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (step) current = step(current);
    version += 1;
  }
  const merged = mergeDeep(DEFAULT_SETTINGS, current);
  // Arrays replace wholesale in mergeDeep, so their elements are validated here.
  return {
    ...merged,
    providers: sanitizeProviders(merged.providers),
    schemaVersion: SETTINGS_VERSION,
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return migrate(stored[SETTINGS_KEY]);
}

export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = migrate(mergeDeep(current, patch));
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings(): Promise<Settings> {
  const next = structuredClone(DEFAULT_SETTINGS);
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Subscribe to settings changes from any context. Returns an unsubscribe function. */
export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area !== 'local') return;
    const change = changes[SETTINGS_KEY];
    if (change) callback(migrate(change.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}
