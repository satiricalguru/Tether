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

export type ReasoningMode = 'auto' | 'on' | 'off';

export interface GenerationSettings {
  temperature: number;
  topP: number;
  maxTokens: number;
  /** Context window to request; 0 = server default. */
  numCtx: number;
  /** -1 = random. */
  seed: number;
}

/** Pick a default model for new chats started on matching sites. */
export interface SiteRule {
  /** Hostname or *.suffix, e.g. "github.com", "*.atlassian.net". */
  pattern: string;
  instanceId: string;
  model: string;
}

export interface ChatPrefs {
  /** Enter sends; Shift+Enter adds a newline. False swaps them (Ctrl/Cmd+Enter sends). */
  enterToSend: boolean;
  /** Expand reasoning by default. */
  showReasoning: boolean;
}

export interface PagePrefs {
  /** Show the highlight-to-ask bubble on sites Tether may read. */
  bubble: boolean;
  /** Cmd/Ctrl+K in a text field opens inline compose, on sites Tether may read. */
  compose: boolean;
  /** Translate target; empty = the browser's UI language. */
  translateTo: string;
}

export interface RagPrefs {
  /** Send the parts of long pages/PDFs most relevant to the question, instead of the start. */
  enabled: boolean;
  /** Embedding model on the conversation's provider; empty = pick an installed one. */
  embeddingModel: string;
}

export type ToolTierSetting = 'auto' | 'native' | 'constrained' | 'text';

export interface AgentPrefs {
  /** Force a tool-calling tier; 'auto' picks per model. */
  toolTier: ToolTierSetting;
  maxSteps: number;
  maxMinutes: number;
  maxConsecutiveFailures: number;
  /** Hosts the agent may visit even if a default rule blocks them. */
  allowDomains: string[];
  /** Hosts the agent may never visit. */
  blockDomains: string[];
  /** 'debugger' sends trusted input via the Chrome DevTools protocol (optional permission). */
  inputBackend: 'scripting' | 'debugger';
  /** Ask the model to check its answer against the final page before finishing. */
  critique: boolean;
}

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
  generation: GenerationSettings;
  systemPrompt: string;
  reasoning: ReasoningMode;
  siteRules: SiteRule[];
  chat: ChatPrefs;
  page: PagePrefs;
  rag: RagPrefs;
  agent: AgentPrefs;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are Tether, a helpful assistant running locally on the user’s computer. Be concise and accurate. Use Markdown when it helps readability.';

export const SETTINGS_KEY = 'tether:settings';
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_VERSION,
  theme: 'system',
  providers: BUILTIN_PROVIDERS.map((p) => ({ ...p })),
  selection: { instanceId: '', model: '' },
  discoveredAt: 0,
  generation: { temperature: 0.7, topP: 0.9, maxTokens: 2048, numCtx: 8192, seed: -1 },
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reasoning: 'auto',
  siteRules: [],
  chat: { enterToSend: true, showReasoning: false },
  page: { bubble: true, compose: true, translateTo: '' },
  rag: { enabled: true, embeddingModel: '' },
  agent: {
    toolTier: 'auto',
    maxSteps: 15,
    maxMinutes: 5,
    maxConsecutiveFailures: 3,
    allowDomains: [],
    blockDomains: [],
    inputBackend: 'scripting',
    critique: true,
  },
};

function sanitizeSiteRules(raw: unknown): SiteRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is SiteRule =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as SiteRule).pattern === 'string' &&
      typeof (r as SiteRule).instanceId === 'string' &&
      typeof (r as SiteRule).model === 'string',
  );
}

/** "github.com" matches github.com and www.github.com; "*.github.com" matches any subdomain. */
export function hostMatches(pattern: string, hostname: string): boolean {
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const h = hostname.toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === p || h === `www.${p}`;
}

export function matchSiteRule(rules: SiteRule[], url: string | undefined): SiteRule | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return rules.find((r) => hostMatches(r.pattern, host));
}

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
    siteRules: sanitizeSiteRules(merged.siteRules),
    reasoning: (['auto', 'on', 'off'] as const).includes(merged.reasoning)
      ? merged.reasoning
      : 'auto',
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
