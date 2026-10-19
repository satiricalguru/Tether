import type { ProviderConfig, ProviderKind } from './types';

const base = { enabled: true, apiKey: '', useOpenAICompat: false };

/** Always present in settings (can be disabled, not deleted). */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    ...base,
    instanceId: 'ollama',
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
  },
  {
    ...base,
    instanceId: 'lmstudio',
    kind: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234',
  },
  {
    ...base,
    instanceId: 'llamacpp',
    kind: 'llamacpp',
    label: 'llama.cpp',
    baseUrl: 'http://127.0.0.1:8080',
  },
  {
    ...base,
    instanceId: 'vllm',
    kind: 'openai-compatible',
    label: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000',
  },
];

export interface DiscoveryCandidate {
  instanceId: string;
  label: string;
  baseUrl: string;
  /** Fingerprints to try in order; the first that answers wins. */
  kinds: ProviderKind[];
}

/**
 * Probed in parallel on first run and on "Rescan". Ports overlap between
 * servers (LocalAI also defaults to :8080), so each candidate lists the kinds
 * it may be and is fingerprinted rather than assumed.
 */
export const DISCOVERY_CANDIDATES: DiscoveryCandidate[] = [
  { instanceId: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', kinds: ['ollama'] },
  {
    instanceId: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234',
    kinds: ['lmstudio', 'openai-compatible'],
  },
  {
    instanceId: 'llamacpp',
    label: 'llama.cpp',
    baseUrl: 'http://127.0.0.1:8080',
    kinds: ['llamacpp', 'openai-compatible'],
  },
  {
    instanceId: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000',
    kinds: ['openai-compatible'],
  },
  {
    instanceId: 'jan',
    label: 'Jan',
    baseUrl: 'http://127.0.0.1:1337',
    kinds: ['openai-compatible'],
  },
  {
    instanceId: 'koboldcpp',
    label: 'KoboldCpp',
    baseUrl: 'http://127.0.0.1:5001',
    kinds: ['openai-compatible'],
  },
  {
    instanceId: 'tgwui',
    label: 'text-generation-webui / TabbyAPI',
    baseUrl: 'http://127.0.0.1:5000',
    kinds: ['openai-compatible'],
  },
];

const KINDS: ProviderKind[] = ['ollama', 'lmstudio', 'llamacpp', 'openai-compatible'];

function isConfig(v: unknown): v is ProviderConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.instanceId === 'string' &&
    c.instanceId.length > 0 &&
    typeof c.label === 'string' &&
    typeof c.baseUrl === 'string' &&
    KINDS.includes(c.kind as ProviderKind)
  );
}

/** Validate stored provider configs, fill defaults, and guarantee the built-ins exist. */
export function sanitizeProviders(raw: unknown): ProviderConfig[] {
  const seen = new Set<string>();
  const out: ProviderConfig[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isConfig(item) || seen.has(item.instanceId)) continue;
    seen.add(item.instanceId);
    out.push({
      instanceId: item.instanceId,
      kind: item.kind,
      label: item.label,
      baseUrl: item.baseUrl,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      useOpenAICompat: typeof item.useOpenAICompat === 'boolean' ? item.useOpenAICompat : false,
    });
  }
  for (const builtin of BUILTIN_PROVIDERS) {
    if (!seen.has(builtin.instanceId)) out.push({ ...builtin });
  }
  return out;
}

export function isBuiltin(instanceId: string): boolean {
  return BUILTIN_PROVIDERS.some((p) => p.instanceId === instanceId);
}
