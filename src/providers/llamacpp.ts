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

export interface LlamaProps {
  default_generation_settings?: { n_ctx?: number };
  n_ctx?: number;
  model_path?: string;
  chat_template?: string;
  modalities?: { vision?: boolean };
  build_info?: string;
}

export function llamaCapabilities(props: LlamaProps): Capabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    // Native tools need the server started with --jinja and a tool-aware
    // template; a template that never mentions tools certainly can't. A 500
    // "requires --jinja" at request time downgrades the rest.
    nativeTools: /\btools\b/.test(props.chat_template ?? ''),
    vision: props.modalities?.vision ?? false,
    jsonMode: true,
    jsonSchema: true,
    grammar: true,
    // n_ctx is what the server actually allocated, the real limit.
    contextLength:
      props.default_generation_settings?.n_ctx ?? props.n_ctx ?? DEFAULT_CAPABILITIES.contextLength,
    thinking: /<think>|enable_thinking|reasoning/i.test(props.chat_template ?? ''),
  };
}

export function createLlamaCpp(config: ProviderConfig, deps: AdapterDeps): Provider {
  const base = config.baseUrl;
  const { http, overrides } = deps;
  const ctx: OpenAIContext = {
    http,
    apiBase: openAIApiBase(base),
    instanceId: config.instanceId,
    overrides,
  };

  const props = async (timeoutMs?: number): Promise<LlamaProps> => {
    const json = (await http.json(`${base}/props`, timeoutMs ? { timeoutMs } : {})) as LlamaProps;
    if (typeof json !== 'object' || !('default_generation_settings' in json || 'n_ctx' in json)) {
      throw new WrongServerError('a llama.cpp server');
    }
    return json;
  };

  return {
    id: 'llamacpp',
    instanceId: config.instanceId,
    label: config.label,
    baseUrl: base,

    health: () =>
      probeHealth(async () => {
        try {
          const p = await props(HEALTH_TIMEOUT_MS);
          return p.build_info;
        } catch (err) {
          // 503 while the model is still loading: reachable but not ready.
          if (err instanceof ProviderError && err.status === 503) {
            throw new ProviderError('E_HTTP', 'llama.cpp is still loading the model', {
              status: 503,
            });
          }
          throw err;
        }
      }),

    async listModels() {
      const [models, p] = await Promise.all([
        openAIListModels(ctx),
        props().catch(() => undefined),
      ]);
      return models.map((m): ModelInfo => {
        const info: ModelInfo = { ...m, loaded: true };
        if (p) info.capabilities = llamaCapabilities(p);
        const nCtx = p?.default_generation_settings?.n_ctx ?? p?.n_ctx;
        if (nCtx) info.contextLength = nCtx;
        return info;
      });
    },

    async capabilities(model) {
      return {
        ...llamaCapabilities(await props()),
        ...(await overrides.get(config.instanceId, model)),
      };
    },

    async *chat(req, signal) {
      const o = await overrides.get(config.instanceId, req.model);
      yield* openAIChat(ctx, req, signal, {
        jsonModeAs: 'json_object',
        streamUsage: o.streamUsage !== false,
        extraBody: (r) => (r.grammar ? { grammar: r.grammar } : {}),
      });
    },

    embed: (texts, model) => openAIEmbed(ctx, texts, model),

    // One model per server process: if it answers, the model is resident.
    isLoaded: () => Promise.resolve(true),

    async runtimeContext() {
      const p = await props().catch(() => undefined);
      return p?.default_generation_settings?.n_ctx ?? p?.n_ctx;
    },
  };
}
