import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatStream } from '@/background/chat';
import { echoStream } from '@/background/echo';
import { providerHandlers } from '@/background/providers';
import { App } from '@/entrypoints/sidepanel/App';
import { registerHandlers } from '@/lib/messaging';
import { registerStreamHandlers } from '@/lib/ports';
import { getSettings } from '@/lib/settings';
import { memoryOverrides } from '@/providers/overrides';
import { ProviderRegistry } from '@/providers/registry';
import { fakeFetch, json } from '../helpers/fake-fetch';
import { fixtureBytes, streamResponse } from '../helpers/streams';

afterEach(cleanup);

type Routes = Parameters<typeof fakeFetch>[0];

/** Wire the real background handlers to a registry whose network is `routes`. */
function background(routes: Routes) {
  const { impl } = fakeFetch(routes);
  const registry = new ProviderRegistry({
    getConfigs: async () => (await getSettings()).providers,
    overrides: memoryOverrides(),
    fetchImpl: impl,
  });
  registerHandlers({
    'bg:ping': () => ({ pong: true, version: '0.1.0', at: 0 }),
    ...providerHandlers(registry),
  });
  registerStreamHandlers({
    echo: echoStream,
    chat: createChatStream({ getProvider: (id) => registry.provider(id) }),
  });
}

const OLLAMA_OK: Routes = {
  'GET /api/version': () => json({ version: '0.12.6' }),
  'GET /api/tags': () =>
    json({
      models: [
        { name: 'llama3.2:3b', details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
        { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
      ],
    }),
  'GET /api/ps': () => json({ models: [{ name: 'llama3.2:3b' }] }),
  'POST /api/show': () =>
    json({
      capabilities: ['completion', 'tools'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
    }),
  'POST /api/chat': () => streamResponse(fixtureBytes('ollama-chat-basic.ndjson'), { cuts: [40] }),
};

describe('side panel', () => {
  it('shows the Setup Doctor with the OLLAMA_ORIGINS fix when Ollama blocks the origin', async () => {
    background({ 'GET /api/version': () => new Response(null, { status: 403 }) });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('doctor-summary').textContent).toBe('No local model server found');
    });
    const row = await screen.findByTestId('doctor-ollama');
    expect(row.dataset.diagnosis).toBe('origin-blocked');
    expect(row.textContent).toContain('Blocked by origin check');
    expect(row.textContent).toContain(
      'launchctl setenv OLLAMA_ORIGINS "chrome-extension://test-extension-id"',
    );
    // Not-running built-ins are summarized, not shouted.
    expect(screen.getByText(/Not running: LM Studio, llama\.cpp, vLLM/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('transport-check').textContent).toContain('streaming OK');
    });
  });

  it('picks the hot model and streams a quick prompt with metrics', async () => {
    background(OLLAMA_OK);
    render(<App />);
    const picker = await screen.findByTestId('model-picker');
    await waitFor(() => {
      expect(picker.textContent).toContain('llama3.2:3b');
    });
    await waitFor(async () => {
      expect((await getSettings()).selection).toEqual({
        instanceId: 'ollama',
        model: 'llama3.2:3b',
      });
    });

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Say hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByTestId('run-output').dataset.phase).toBe('done');
    });
    expect(screen.getByTestId('run-text').textContent).toBe('Bonjour — ça va? 👋 你好');
    const metrics = screen.getByTestId('metrics').textContent;
    expect(metrics).toContain('tok/s25.0');
    expect(metrics).toContain('prompt26 tok');
    expect(metrics).toContain('load1.85 s');
  });
});
