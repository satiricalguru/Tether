/// <reference types="chrome" />
import type { Worker } from '@playwright/test';
import { startMockLlm, type MockOptions, type MockServer } from '../fixtures/mock-llm/server';

export interface E2EProvider {
  instanceId: string;
  kind: 'ollama' | 'lmstudio' | 'llamacpp' | 'openai-compatible';
  label: string;
  baseUrl: string;
  enabled?: boolean;
  apiKey?: string;
}

/** First-run discovery writes settings; wait for it so tests don't race it. */
export async function waitForDiscovery(sw: Worker): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const done = await sw.evaluate(async () => {
      const s = (await chrome.storage.local.get('tether:settings'))['tether:settings'] as
        { discoveredAt?: number } | undefined;
      return (s?.discoveredAt ?? 0) > 0;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('first-run discovery never completed');
}

/**
 * Replace the provider list. Built-ins not listed are disabled so a model
 * server actually running on the developer's machine can't leak into tests.
 */
export async function configureProviders(sw: Worker, providers: E2EProvider[]): Promise<void> {
  await waitForDiscovery(sw);
  const builtins = ['ollama', 'lmstudio', 'llamacpp', 'vllm'];
  const defaults: Record<string, Omit<E2EProvider, 'instanceId'>> = {
    ollama: { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
    lmstudio: { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234' },
    llamacpp: { kind: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080' },
    vllm: { kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000' },
  };
  const list = [
    ...providers.map((p) => ({ enabled: true, apiKey: '', useOpenAICompat: false, ...p })),
    ...builtins
      .filter((id) => !providers.some((p) => p.instanceId === id))
      .map((id) => ({
        instanceId: id,
        ...defaults[id],
        enabled: false,
        apiKey: '',
        useOpenAICompat: false,
      })),
  ];
  await sw.evaluate(async (providerList) => {
    const key = 'tether:settings';
    const current = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      [key]: {
        ...current,
        schemaVersion: 1,
        providers: providerList,
        selection: { instanceId: '', model: '' },
        discoveredAt: Date.now(),
      },
    });
  }, list);
}

export async function withMock(opts: MockOptions): Promise<MockServer> {
  return startMockLlm({ tokenDelayMs: 5, ...opts });
}
