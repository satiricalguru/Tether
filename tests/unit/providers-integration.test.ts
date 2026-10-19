// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createChatStream, type ChatStreamEvent } from '@/background/chat';
import type { DiscoveryCandidate } from '@/providers/defaults';
import { memoryOverrides } from '@/providers/overrides';
import { ProviderRegistry, mergeDiscovery } from '@/providers/registry';
import type { ProviderConfig, ProviderKind } from '@/providers/types';
import { startMockLlm, type MockOptions, type MockServer } from '../fixtures/mock-llm/server';

/**
 * Real adapters + registry against the mock backends over real HTTP. No
 * fakes between the provider layer and the socket.
 */

const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function mock(opts: MockOptions): Promise<MockServer> {
  const s = await startMockLlm({ tokenDelayMs: 1, ...opts });
  servers.push(s);
  return s;
}

function config(
  instanceId: string,
  kind: ProviderKind,
  baseUrl: string,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    instanceId,
    kind,
    label: instanceId,
    baseUrl,
    enabled: true,
    apiKey: '',
    useOpenAICompat: false,
    ...extra,
  };
}

function registryFor(configs: ProviderConfig[]) {
  const overrides = memoryOverrides();
  return {
    registry: new ProviderRegistry({ getConfigs: () => Promise.resolve(configs), overrides }),
    overrides,
  };
}

async function runChat(
  registry: ProviderRegistry,
  req: Parameters<ReturnType<typeof createChatStream>>[0],
  signal = new AbortController().signal,
) {
  const handler = createChatStream({
    getProvider: (id) => registry.provider(id),
    contextLength: async (id, m) => (await registry.capabilities(id, m)).contextLength,
    thresholds: { knownCold: 200, unknown: 300, knownHot: 400 },
  });
  const it = handler(req, { signal, sender: undefined });
  const events: ChatStreamEvent[] = [];
  for (;;) {
    const step = await it.next();
    if (step.done) return { events, done: step.value };
    events.push(step.value);
  }
}

const text = (events: ChatStreamEvent[]) =>
  events.map((e) => (e.type === 'text' ? e.text : '')).join('');
const statuses = (events: ChatStreamEvent[]) =>
  events.flatMap((e) => (e.type === 'status' ? [e.status] : []));

describe.each<[ProviderKind, MockOptions['flavor'], string]>([
  ['ollama', 'ollama', 'llama3.2:3b'],
  ['lmstudio', 'lmstudio', 'qwen2.5-7b-instruct'],
  ['llamacpp', 'llamacpp', 'mock.gguf'],
  ['openai-compatible', 'openai', 'Qwen/Qwen2.5-7B-Instruct'],
])('%s against the mock', (kind, flavor, model) => {
  it('is healthy, lists models with capabilities and streams a reply with metrics', async () => {
    const server = await mock({ flavor });
    const { registry } = registryFor([config('p', kind, server.url)]);

    const [status] = await registry.status();
    expect(status?.health).toMatchObject({ ok: true, diagnosis: 'ok' });

    const models = await registry.models('p');
    const m = models.find((x) => x.id === model);
    expect(m?.capabilities?.contextLength).toBeGreaterThan(0);

    const { events, done } = await runChat(registry, {
      instanceId: 'p',
      model,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(text(events)).toBe('Hello from the mock model.');
    expect(statuses(events)[0]).toBe('waiting');
    expect(statuses(events)).toContain('generating');
    expect(done.metrics.finishReason).toBe('stop');
    expect(done.metrics.ttftMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics.completionTokens).toBeGreaterThan(0);
    expect(done.metrics.tokensPerSecond).toBeGreaterThan(0);
    expect(done.metrics.contextLength).toBeGreaterThan(0);
  });

  it('passes native tool calls through', async () => {
    const server = await mock({
      flavor,
      ...(flavor === 'ollama'
        ? { models: [{ id: 'mock-toolcall', loaded: true, tools: true }] }
        : {}),
    });
    const { registry } = registryFor([config('p', kind, server.url)]);
    const { events, done } = await runChat(registry, {
      instanceId: 'p',
      model: 'mock-toolcall',
      messages: [{ role: 'user', content: 'click it' }],
      tools: [{ name: 'click', description: 'Click', parameters: { type: 'object' } }],
    });
    const calls = events.find((e) => e.type === 'tool_calls');
    expect(calls).toMatchObject({ calls: [{ name: 'click' }] });
    expect(JSON.parse((calls as { calls: { arguments: string }[] }).calls[0]!.arguments)).toEqual({
      id: 3,
    });
    expect(done.metrics.finishReason).toBe('tool_calls');
  });

  it('downgrades tools on rejection and the capability sticks', async () => {
    const server = await mock({
      flavor,
      ...(flavor === 'ollama'
        ? { models: [{ id: 'mock-notools', loaded: true, tools: true }] }
        : {}),
    });
    const { registry } = registryFor([config('p', kind, server.url)]);
    const err = await runChat(registry, {
      instanceId: 'p',
      model: 'mock-notools',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'click', description: 'Click', parameters: { type: 'object' } }],
    }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('E_TOOLS_UNSUPPORTED');
    await expect(registry.capabilities('p', 'mock-notools')).resolves.toMatchObject({
      nativeTools: false,
    });
  });

  it('fails cleanly on a mid-stream disconnect', async () => {
    const server = await mock({
      flavor,
      ...(flavor === 'ollama' ? { models: [{ id: 'mock-disconnect', loaded: true }] } : {}),
    });
    const { registry } = registryFor([config('p', kind, server.url)]);
    await expect(
      runChat(registry, {
        instanceId: 'p',
        model: 'mock-disconnect',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow();
  });
});

describe('cold models and the TTFT watchdog', () => {
  it('reports loading-model for a model that was not resident (Ollama)', async () => {
    const server = await mock({ flavor: 'ollama', models: [{ id: 'mock-cold' }] });
    const { registry } = registryFor([config('o', 'ollama', server.url)]);
    const { events, done } = await runChat(registry, {
      instanceId: 'o',
      model: 'mock-cold',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(statuses(events)).toEqual(['waiting', 'loading-model', 'generating']);
    expect(done.metrics.ttftMs).toBeGreaterThanOrEqual(2000);
    expect(done.metrics.loadMs).toBeGreaterThan(0);
  }, 15_000);

  it('reports loading-model for a JIT-loaded LM Studio model', async () => {
    const server = await mock({ flavor: 'lmstudio' });
    const { registry } = registryFor([config('l', 'lmstudio', server.url)]);
    await registry.models('l');
    const { events } = await runChat(registry, {
      instanceId: 'l',
      model: 'mock-cold',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(statuses(events)).toContain('loading-model');
  }, 15_000);

  it('reports slow (not loading) when a resident model is just slow to start', async () => {
    const server = await mock({ flavor: 'ollama', models: [{ id: 'mock-slow', loaded: true }] });
    const { registry } = registryFor([config('o', 'ollama', server.url)]);
    const { events } = await runChat(registry, {
      instanceId: 'o',
      model: 'mock-slow',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(statuses(events)).toEqual(['waiting', 'slow', 'generating']);
  }, 15_000);

  it('aborts mid-generation', async () => {
    const server = await mock({
      flavor: 'openai',
      tokenDelayMs: 50,
      reply: 'one two three four five six seven',
    });
    const { registry } = registryFor([config('v', 'openai-compatible', server.url)]);
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort(new DOMException('stop', 'AbortError'));
    }, 120);
    await expect(
      runChat(
        registry,
        { instanceId: 'v', model: 'x', messages: [{ role: 'user', content: 'x' }] },
        ctrl.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('diagnosis', () => {
  it('detects the Ollama origin check and clears once the origin is allowed', async () => {
    // Node's fetch sends no Origin header; inject the one Chrome would send.
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const fetchWithOrigin: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), Origin: origin },
      });

    const blocked = await mock({ flavor: 'ollama', rejectOrigins: true, allowedOrigins: [] });
    const reg1 = new ProviderRegistry({
      getConfigs: () => Promise.resolve([config('o', 'ollama', blocked.url)]),
      overrides: memoryOverrides(),
      fetchImpl: fetchWithOrigin,
    });
    expect((await reg1.status())[0]?.health).toMatchObject({
      ok: false,
      diagnosis: 'origin-blocked',
    });

    const allowed = await mock({
      flavor: 'ollama',
      rejectOrigins: true,
      allowedOrigins: ['chrome-extension://*'],
    });
    const reg2 = new ProviderRegistry({
      getConfigs: () => Promise.resolve([config('o', 'ollama', allowed.url)]),
      overrides: memoryOverrides(),
      fetchImpl: fetchWithOrigin,
    });
    expect((await reg2.status())[0]?.health).toMatchObject({ ok: true });
  });

  it('reports auth-required for a keyed server and works with the key', async () => {
    const server = await mock({ flavor: 'openai', apiKey: 'sk-local-secret' });
    const { registry: noKey } = registryFor([config('v', 'openai-compatible', server.url)]);
    expect((await noKey.status())[0]?.health?.diagnosis).toBe('auth-required');
    const { registry: keyed } = registryFor([
      config('v', 'openai-compatible', server.url, { apiKey: 'sk-local-secret' }),
    ]);
    expect((await keyed.status())[0]).toMatchObject({ hasApiKey: true, health: { ok: true } });
  });

  it('never reaches an origin that is not configured', async () => {
    const server = await mock({ flavor: 'openai' });
    const { registry } = registryFor([config('v', 'openai-compatible', 'http://127.0.0.1:1')]);
    await registry.status();
    expect(server.requests).toHaveLength(0);
  });
});

describe('discovery', () => {
  it('fingerprints each port, tells llama.cpp from other OpenAI servers, and merges', async () => {
    const [ollama, lms, llama, localai] = await Promise.all([
      mock({ flavor: 'ollama' }),
      mock({ flavor: 'lmstudio' }),
      mock({ flavor: 'llamacpp' }),
      mock({ flavor: 'openai' }),
    ]);
    const candidates: DiscoveryCandidate[] = [
      { instanceId: 'ollama', label: 'Ollama', baseUrl: ollama.url, kinds: ['ollama'] },
      {
        instanceId: 'lmstudio',
        label: 'LM Studio',
        baseUrl: lms.url,
        kinds: ['lmstudio', 'openai-compatible'],
      },
      {
        instanceId: 'llamacpp',
        label: 'llama.cpp',
        baseUrl: llama.url,
        kinds: ['llamacpp', 'openai-compatible'],
      },
      {
        instanceId: 'other',
        label: 'llama.cpp',
        baseUrl: localai.url,
        kinds: ['llamacpp', 'openai-compatible'],
      },
      {
        instanceId: 'jan',
        label: 'Jan',
        baseUrl: 'http://127.0.0.1:1',
        kinds: ['openai-compatible'],
      },
    ];
    const configs = [
      config('ollama', 'ollama', ollama.url),
      config('other', 'llamacpp', localai.url),
    ];
    const reg = new ProviderRegistry({
      getConfigs: () => Promise.resolve(configs),
      overrides: memoryOverrides(),
    });
    const results = await reg.discover(candidates);
    expect(results.map((r) => [r.instanceId, r.kind, r.health.diagnosis])).toEqual([
      ['ollama', 'ollama', 'ok'],
      ['lmstudio', 'lmstudio', 'ok'],
      ['llamacpp', 'llamacpp', 'ok'],
      // Answers /v1/models but has no /props: not llama.cpp.
      ['other', 'openai-compatible', 'ok'],
      ['jan', 'openai-compatible', 'unreachable'],
    ]);

    const merged = mergeDiscovery(configs, results);
    expect(merged.map((c) => [c.instanceId, c.kind, c.baseUrl])).toEqual([
      ['ollama', 'ollama', ollama.url],
      // The configured "llama.cpp" on that port is corrected, not duplicated.
      ['other', 'openai-compatible', localai.url],
      ['lmstudio', 'lmstudio', lms.url],
      ['llamacpp', 'llamacpp', llama.url],
    ]);
    expect(merged[1]?.label).toBe(`OpenAI-compatible (${new URL(localai.url).host})`);
  });
});
