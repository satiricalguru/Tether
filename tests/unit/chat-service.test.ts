import { describe, expect, it } from 'vitest';
import { createChatStream, type ChatStreamEvent } from '@/background/chat';
import { memoryOverrides } from '@/providers/overrides';
import { ProviderRegistry } from '@/providers/registry';
import type { ChatChunk, Provider } from '@/providers/types';
import { json, fakeFetch } from '../helpers/fake-fetch';

/** `chunks` entries may be numbers: "advance the clock to this time". */
function fakeProvider(
  chunks: (ChatChunk | number)[],
  clock: { t: number },
  opts: { loaded?: boolean } = {},
): Provider {
  return {
    id: 'openai-compatible',
    instanceId: 'p',
    label: 'p',
    baseUrl: 'http://127.0.0.1:1',
    health: () => Promise.resolve({ ok: true, latencyMs: 1, diagnosis: 'ok' }),
    listModels: () => Promise.resolve([]),
    capabilities: () => Promise.reject(new Error('unused')),
    // eslint-disable-next-line @typescript-eslint/require-await -- generator over fixed data
    chat: async function* () {
      for (const c of chunks) {
        if (typeof c === 'number') clock.t = c;
        else yield c;
      }
    },
    ...(opts.loaded === undefined ? {} : { isLoaded: () => Promise.resolve(opts.loaded) }),
  };
}

async function run(provider: Provider, now: () => number) {
  const handler = createChatStream({ getProvider: () => Promise.resolve(provider), now });
  const it = handler(
    { instanceId: 'p', model: 'm', messages: [] },
    { signal: new AbortController().signal, sender: undefined },
  );
  const events: ChatStreamEvent[] = [];
  for (;;) {
    const step = await it.next();
    if (step.done) return { events, metrics: step.value.metrics };
    events.push(step.value);
  }
}

describe('chat stream metrics', () => {
  it('estimates completion tokens and speed when the server reports no usage', async () => {
    const clock = { t: 0 };
    const { metrics, events } = await run(
      fakeProvider(
        [
          100,
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
          { type: 'text', text: 'c' },
          { type: 'finish', reason: 'stop', usage: {} },
          1100,
        ],
        clock,
      ),
      () => clock.t,
    );
    expect(events.filter((e) => e.type === 'text')).toHaveLength(3);
    expect(metrics.completionTokens).toBe(3);
    expect(metrics.completionTokensEstimated).toBe(true);
    expect(metrics.ttftMs).toBe(100);
    // 3 tokens over the 1 s between first token and end.
    expect(metrics.tokensPerSecond).toBe(3);
    expect(metrics.totalMs).toBe(1100);
    expect(metrics.finishReason).toBe('stop');
  });

  it('prefers server usage and speed', async () => {
    const clock = { t: 0 };
    const { metrics } = await run(
      fakeProvider(
        [
          { type: 'text', text: 'a' },
          {
            type: 'finish',
            reason: 'length',
            usage: {
              promptTokens: 50,
              completionTokens: 20,
              tokensPerSecond: 42.123,
              loadMs: 900.4,
            },
          },
        ],
        clock,
      ),
      () => clock.t,
    );
    expect(metrics).toMatchObject({
      promptTokens: 50,
      completionTokens: 20,
      completionTokensEstimated: false,
      tokensPerSecond: 42.1,
      loadMs: 900,
      finishReason: 'length',
    });
  });
});

describe('registry.allModels', () => {
  it('groups healthy providers and lists hot models first', async () => {
    const { impl } = fakeFetch({
      'GET /api/version': () => json({ version: '0.12.6' }),
      'GET /api/tags': () =>
        json({ models: [{ name: 'b:1b' }, { name: 'a:1b' }, { name: 'z:1b' }] }),
      'GET /api/ps': () => json({ models: [{ name: 'z:1b' }] }),
      'POST /api/show': () => json({ capabilities: ['completion'] }),
    });
    const registry = new ProviderRegistry({
      getConfigs: () =>
        Promise.resolve([
          {
            instanceId: 'ollama',
            kind: 'ollama',
            label: 'Ollama',
            baseUrl: 'http://127.0.0.1:11434',
            enabled: true,
            apiKey: '',
            useOpenAICompat: false,
          },
          {
            instanceId: 'off',
            kind: 'lmstudio',
            label: 'Off',
            baseUrl: 'http://127.0.0.1:1234',
            enabled: false,
            apiKey: '',
            useOpenAICompat: false,
          },
        ]),
      overrides: memoryOverrides(),
      fetchImpl: impl,
    });
    const groups = await registry.allModels();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['z:1b', 'a:1b', 'b:1b']);
  });
});
