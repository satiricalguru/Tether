import { TetherError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { AdapterDeps } from './adapter';
import { DISCOVERY_CANDIDATES, type DiscoveryCandidate } from './defaults';
import { HttpClient, originOf } from './http';
import { createLlamaCpp } from './llamacpp';
import { createLmStudio } from './lmstudio';
import { createOllama } from './ollama';
import { createOpenAICompatible } from './openai-compatible';
import type { CapabilityOverrides } from './overrides';
import type {
  Capabilities,
  HealthResult,
  ModelInfo,
  Provider,
  ProviderConfig,
  ProviderKind,
} from './types';

const log = createLogger('providers');

export function createProvider(config: ProviderConfig, deps: AdapterDeps): Provider {
  switch (config.kind) {
    case 'ollama':
      return createOllama(config, deps);
    case 'lmstudio':
      return createLmStudio(config, deps);
    case 'llamacpp':
      return createLlamaCpp(config, deps);
    case 'openai-compatible':
      return createOpenAICompatible(config, deps);
  }
}

/** Safe-to-display view of a config: the API key never leaves the background. */
export interface ProviderStatus {
  instanceId: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  useOpenAICompat: boolean;
  /** null when the provider is disabled (not probed). */
  health: HealthResult | null;
}

export interface CandidateResult {
  instanceId: string;
  label: string;
  baseUrl: string;
  /** The fingerprint that matched, if any. */
  kind?: ProviderKind;
  health: HealthResult;
}

export interface ModelGroup {
  instanceId: string;
  label: string;
  kind: ProviderKind;
  models: ModelInfo[];
}

export interface RegistryDeps {
  getConfigs: () => Promise<ProviderConfig[]>;
  overrides: CapabilityOverrides;
  fetchImpl?: typeof fetch;
  hasHostPermission?: (origin: string) => Promise<boolean>;
  /** Capability cache lifetime. */
  capabilityTtlMs?: number;
  now?: () => number;
}

const DEFAULT_CAPABILITY_TTL = 5 * 60_000;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export class ProviderRegistry {
  private allowed = new Set<string>(DISCOVERY_CANDIDATES.map((c) => originOf(c.baseUrl)));
  private readonly http: HttpClient;
  private readonly capCache = new Map<string, { at: number; caps: Capabilities }>();

  constructor(private readonly deps: RegistryDeps) {
    this.http = new HttpClient({
      isAllowedOrigin: (origin) => this.allowed.has(origin),
      ...(deps.hasHostPermission ? { hasHostPermission: deps.hasHostPermission } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  private get adapterDeps(): AdapterDeps {
    return { http: this.http, overrides: this.deps.overrides };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Load configs and refresh the egress allowlist to exactly what is configured. */
  async configs(): Promise<ProviderConfig[]> {
    const configs = await this.deps.getConfigs();
    const allowed = new Set(DISCOVERY_CANDIDATES.map((c) => originOf(c.baseUrl)));
    for (const c of configs) {
      try {
        allowed.add(originOf(c.baseUrl));
      } catch {
        log.warn('ignoring provider with invalid base URL', c.instanceId);
      }
    }
    this.allowed = allowed;
    return configs;
  }

  async provider(instanceId: string): Promise<Provider> {
    const config = (await this.configs()).find((c) => c.instanceId === instanceId);
    if (!config) throw new TetherError('E_UNKNOWN_PROVIDER', `No provider "${instanceId}"`);
    if (!config.enabled)
      throw new TetherError('E_PROVIDER_DISABLED', `${config.label} is disabled`);
    return createProvider(config, this.adapterDeps);
  }

  async status(): Promise<ProviderStatus[]> {
    const configs = await this.configs();
    return Promise.all(
      configs.map(async (c) => ({
        instanceId: c.instanceId,
        kind: c.kind,
        label: c.label,
        baseUrl: c.baseUrl,
        enabled: c.enabled,
        hasApiKey: c.apiKey.length > 0,
        useOpenAICompat: c.useOpenAICompat,
        health: c.enabled ? await createProvider(c, this.adapterDeps).health() : null,
      })),
    );
  }

  async capabilities(
    instanceId: string,
    model: string,
    provider?: Provider,
  ): Promise<Capabilities> {
    const key = `${instanceId}::${model}`;
    const hit = this.capCache.get(key);
    if (hit && this.now() - hit.at < (this.deps.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL)) {
      // Overrides can change between cache fills (runtime downgrades).
      return { ...hit.caps, ...(await this.deps.overrides.get(instanceId, model)) };
    }
    const p = provider ?? (await this.provider(instanceId));
    const caps = await p.capabilities(model);
    this.capCache.set(key, { at: this.now(), caps });
    return caps;
  }

  /** Models with capabilities resolved (from the listing, or probed with bounded concurrency). */
  async models(instanceId: string): Promise<ModelInfo[]> {
    const p = await this.provider(instanceId);
    const models = await p.listModels();
    return mapLimit(models, 4, async (m) => {
      try {
        const overrides = await this.deps.overrides.get(instanceId, m.id);
        const caps = m.capabilities
          ? { ...m.capabilities, ...overrides }
          : await this.capabilities(instanceId, m.id, p);
        const out: ModelInfo = { ...m, capabilities: caps };
        out.contextLength ??= caps.contextLength;
        if (out.quantization === undefined && caps.quantization)
          out.quantization = caps.quantization;
        if (caps.embedding) out.kind = 'embeddings';
        return out;
      } catch (err) {
        log.debug('capability probe failed', m.id, err);
        return m;
      }
    });
  }

  /** Every model on every healthy, enabled provider, loaded ("hot") models first. */
  async allModels(): Promise<ModelGroup[]> {
    const configs = (await this.configs()).filter((c) => c.enabled);
    const groups = await Promise.all(
      configs.map(async (c): Promise<ModelGroup | null> => {
        const health = await createProvider(c, this.adapterDeps).health();
        if (!health.ok) return null;
        try {
          const models = await this.models(c.instanceId);
          models.sort(
            (a, b) => Number(!!b.loaded) - Number(!!a.loaded) || a.name.localeCompare(b.name),
          );
          return { instanceId: c.instanceId, label: c.label, kind: c.kind, models };
        } catch (err) {
          log.warn('listing models failed', c.instanceId, err);
          return null;
        }
      }),
    );
    return groups.filter((g): g is ModelGroup => g !== null);
  }

  invalidate(instanceId?: string): void {
    for (const key of this.capCache.keys()) {
      if (!instanceId || key.startsWith(`${instanceId}::`)) this.capCache.delete(key);
    }
  }

  /** Probe every well-known local port and fingerprint what answers. */
  async discover(
    candidates: DiscoveryCandidate[] = DISCOVERY_CANDIDATES,
  ): Promise<CandidateResult[]> {
    await this.configs();
    // Probing a port is contacting it: candidates join the allowlist.
    for (const c of candidates) this.allowed.add(originOf(c.baseUrl));
    return Promise.all(candidates.map((c) => this.fingerprint(c)));
  }

  private async fingerprint(candidate: DiscoveryCandidate): Promise<CandidateResult> {
    let last: HealthResult | undefined;
    for (const kind of candidate.kinds) {
      const provider = createProvider(
        {
          instanceId: candidate.instanceId,
          kind,
          label: candidate.label,
          baseUrl: candidate.baseUrl,
          enabled: true,
          apiKey: '',
          useOpenAICompat: false,
        },
        this.adapterDeps,
      );
      const health = await provider.health();
      last = health;
      if (health.ok) return { ...candidate, kind, health };
      // Port closed or blocked: no other fingerprint will do better.
      if (health.diagnosis !== 'bad-response' && health.diagnosis !== 'http-error') {
        return { ...candidate, kind, health };
      }
    }
    return {
      instanceId: candidate.instanceId,
      label: candidate.label,
      baseUrl: candidate.baseUrl,
      health: last ?? { ok: false, latencyMs: 0, diagnosis: 'unreachable' },
    };
  }
}

/**
 * Fold discovery results into the configured providers: add endpoints that
 * answered but aren't configured, and correct the kind of a built-in whose
 * port turned out to host something else (e.g. LocalAI on :8080).
 */
export function mergeDiscovery(
  configs: ProviderConfig[],
  results: CandidateResult[],
): ProviderConfig[] {
  const out = configs.map((c) => ({ ...c }));
  for (const r of results) {
    if (!r.health.ok || !r.kind) continue;
    const existing = out.find((c) => c.baseUrl === r.baseUrl);
    if (!existing) {
      out.push({
        instanceId: out.some((c) => c.instanceId === r.instanceId)
          ? `${r.instanceId}-${out.length}`
          : r.instanceId,
        kind: r.kind,
        label: r.label,
        baseUrl: r.baseUrl,
        enabled: true,
        apiKey: '',
        useOpenAICompat: false,
      });
    } else if (existing.kind !== r.kind) {
      existing.kind = r.kind;
      existing.label =
        r.kind === 'openai-compatible' ? `OpenAI-compatible (${new URL(r.baseUrl).host})` : r.label;
    }
  }
  return out;
}
