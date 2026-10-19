import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChatStream } from '@/background/chat';
import { echoStream } from '@/background/echo';
import { providerHandlers } from '@/background/providers';
import { App } from '@/entrypoints/sidepanel/App';
import { registerHandlers } from '@/lib/messaging';
import { registerStreamHandlers } from '@/lib/ports';
import { getDb } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { memoryOverrides } from '@/providers/overrides';
import { ProviderRegistry } from '@/providers/registry';
import { fakeFetch, json } from '../helpers/fake-fetch';
import { fixtureBytes, streamResponse } from '../helpers/streams';

afterEach(cleanup);
beforeEach(async () => {
  await Promise.all(getDb().tables.map((t) => t.clear()));
});

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

  it('chats: picks the hot model, streams, persists, and never sends reasoning back', async () => {
    let n = 0;
    const bodies: unknown[] = [];
    background({
      ...OLLAMA_OK,
      'POST /api/show': () =>
        json({
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
        }),
      'POST /api/chat': (call) => {
        bodies.push(call.body);
        return streamResponse(
          fixtureBytes(n++ === 0 ? 'ollama-chat-thinking.ndjson' : 'ollama-chat-basic.ndjson'),
          { cuts: [40] },
        );
      },
    });
    render(<App />);
    const picker = await screen.findByTestId('model-picker');
    await waitFor(() => {
      expect(picker.textContent).toContain('llama3.2:3b');
    });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Say hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('msg-assistant').dataset.status).toBe('done');
    });
    expect(screen.getByTestId('msg-assistant').textContent).toContain('Hi there!');
    // Reasoning is hidden by default, one click away.
    expect(screen.queryByTestId('reasoning')).toBeNull();
    fireEvent.click(screen.getByTestId('reasoning-toggle'));
    expect(screen.getByTestId('reasoning').textContent).toBe('The user wants a greeting.');
    expect(screen.getByTestId('panel-title').textContent).toBe('Say hi');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Again in French' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('msg-assistant')[1]?.dataset.status).toBe('done');
    });
    expect(screen.getAllByTestId('msg-assistant')[1]?.textContent).toContain('Bonjour');

    const second = bodies[1] as {
      messages: { role: string; content: string }[];
      options: Record<string, unknown>;
    };
    expect(second.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', expect.stringContaining('Tether') as string],
      ['user', 'Say hi'],
      ['assistant', 'Hi there!'],
      ['user', 'Again in French'],
    ]);
    expect(JSON.stringify(second)).not.toContain('greeting');
    expect(second.options).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 2048,
      num_ctx: 8192,
    });

    const convs = await getDb().conversations.toArray();
    expect(convs).toHaveLength(1);
    expect(await getDb().messages.count()).toBe(4);
  });
});
