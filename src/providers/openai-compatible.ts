import {
  HEALTH_TIMEOUT_MS,
  WrongServerError,
  openAIApiBase,
  probeHealth,
  type AdapterDeps,
} from './adapter';
import { ProviderError } from './http';
import { openAIChat, openAIEmbed, openAIListModels, type OpenAIContext } from './openai-core';
import { DEFAULT_CAPABILITIES, type Provider, type ProviderConfig } from './types';

/**
 * Any server speaking the OpenAI chat-completions API: vLLM, LocalAI, Jan,
 * KoboldCpp, text-generation-webui, TabbyAPI, custom. Capabilities can't be
 * probed, so they start optimistic and are downgraded at runtime (and the
 * downgrade persisted) when the server rejects a feature.
 */
export function createOpenAICompatible(config: ProviderConfig, deps: AdapterDeps): Provider {
  const { http, overrides } = deps;
  const ctx: OpenAIContext = {
    http,
    apiBase: openAIApiBase(config.baseUrl),
    instanceId: config.instanceId,
    overrides,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };

  return {
    id: 'openai-compatible',
    instanceId: config.instanceId,
    label: config.label,
    baseUrl: config.baseUrl,

    health: () =>
      probeHealth(async () => {
        await openAIListModels(ctx, HEALTH_TIMEOUT_MS).catch((err: unknown) => {
          if (err instanceof ProviderError && err.code === 'E_BAD_RESPONSE') {
            throw new WrongServerError('an OpenAI-compatible server');
          }
          throw err;
        });
        return undefined;
      }),

    listModels: () => openAIListModels(ctx),

    async capabilities(model) {
      const listed = (await openAIListModels(ctx).catch(() => [])).find((m) => m.id === model);
      return {
        ...DEFAULT_CAPABILITIES,
        nativeTools: true,
        jsonMode: true,
        jsonSchema: true,
        contextLength: listed?.contextLength ?? 8192,
        ...(listed?.kind === 'embeddings' ? { embedding: true } : {}),
        ...(await overrides.get(config.instanceId, model)),
      };
    },

    async *chat(req, signal) {
      const o = await overrides.get(config.instanceId, req.model);
      yield* openAIChat(ctx, req, signal, {
        jsonModeAs: 'json_object',
        streamUsage: o.streamUsage !== false,
      });
    },

    embed: (texts, model) => openAIEmbed(ctx, texts, model),
  };
}
