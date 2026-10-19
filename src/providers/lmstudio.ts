import {
  HEALTH_TIMEOUT_MS,
  WrongServerError,
  openAIApiBase,
  probeHealth,
  type AdapterDeps,
} from './adapter';
import { ProviderError } from './http';
import { openAIChat, openAIEmbed, openAIListModels, type OpenAIContext } from './openai-core';
import {
  DEFAULT_CAPABILITIES,
  type Capabilities,
  type ModelInfo,
  type Provider,
  type ProviderConfig,
} from './types';

interface LmsModel {
  id: string;
  type?: 'llm' | 'vlm' | 'embeddings';
  arch?: string;
  quantization?: string;
  state?: 'loaded' | 'not-loaded';
  max_context_length?: number;
  loaded_context_length?: number;
  capabilities?: string[];
}

export function lmsModelInfo(m: LmsModel, instanceId: string): ModelInfo {
  const info: ModelInfo = { id: m.id, name: m.id, instanceId, loaded: m.state === 'loaded' };
  if (m.type) info.kind = m.type;
  if (m.quantization) info.quantization = m.quantization;
  if (m.arch) info.family = m.arch;
  if (m.max_context_length) info.contextLength = m.max_context_length;
  info.capabilities = lmsCapabilities(m);
  return info;
}

export function lmsCapabilities(m: LmsModel): Capabilities {
  const caps: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    // LM Studio parses tool calls for most chat templates; newer builds say
    // so explicitly. Without the field, be optimistic and downgrade on 400.
    nativeTools: m.capabilities ? m.capabilities.includes('tool_use') : m.type !== 'embeddings',
    vision: m.type === 'vlm',
    jsonMode: true,
    jsonSchema: true,
    grammar: false,
    contextLength:
      m.loaded_context_length ?? m.max_context_length ?? DEFAULT_CAPABILITIES.contextLength,
  };
  if (m.quantization) caps.quantization = m.quantization;
  if (m.type === 'embeddings') caps.embedding = true;
  return caps;
}

export function createLmStudio(config: ProviderConfig, deps: AdapterDeps): Provider {
  const base = config.baseUrl;
  const { http, overrides } = deps;
  const ctx: OpenAIContext = {
    http,
    apiBase: openAIApiBase(base),
    instanceId: config.instanceId,
    overrides,
  };

  async function nativeModels(timeoutMs?: number): Promise<LmsModel[] | undefined> {
    try {
      const json = (await http.json(`${base}/api/v0/models`, timeoutMs ? { timeoutMs } : {})) as {
        data?: LmsModel[];
      };
      return Array.isArray(json.data) ? json.data : undefined;
    } catch (err) {
      // Pre-0.3.6 LM Studio has no /api/v0; fall back to /v1/models.
      if (err instanceof ProviderError && err.status === 404) return undefined;
      throw err;
    }
  }

  return {
    id: 'lmstudio',
    instanceId: config.instanceId,
    label: config.label,
    baseUrl: base,

    health: () =>
      probeHealth(async () => {
        const native = await nativeModels(HEALTH_TIMEOUT_MS);
        if (native) return undefined;
        await openAIListModels(ctx, HEALTH_TIMEOUT_MS).catch((err: unknown) => {
          if (err instanceof ProviderError && err.code === 'E_BAD_RESPONSE') {
            throw new WrongServerError('LM Studio');
          }
          throw err;
        });
        return undefined;
      }),

    async listModels() {
      const native = await nativeModels();
      if (native) return native.map((m) => lmsModelInfo(m, config.instanceId));
      return openAIListModels(ctx);
    },

    async capabilities(model) {
      const native = await nativeModels();
      const m = native?.find((x) => x.id === model);
      const caps = m
        ? lmsCapabilities(m)
        : { ...DEFAULT_CAPABILITIES, nativeTools: true, jsonMode: true, jsonSchema: true };
      return { ...caps, ...(await overrides.get(config.instanceId, model)) };
    },

    async *chat(req, signal) {
      const o = await overrides.get(config.instanceId, req.model);
      yield* openAIChat(ctx, req, signal, {
        jsonModeAs: 'json_schema',
        streamUsage: o.streamUsage !== false,
      });
    },

    embed: (texts, model) => openAIEmbed(ctx, texts, model),

    async isLoaded(model) {
      try {
        const native = await nativeModels(HEALTH_TIMEOUT_MS);
        const m = native?.find((x) => x.id === model);
        return m ? m.state === 'loaded' : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
