/// <reference types="chrome" />
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

interface ChatBody {
  messages: { role: string; content: string }[];
}

const chatBodies = (mock: { requests: { path: string; body: unknown }[] }) =>
  mock.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as ChatBody);

const FACT = 'The overnight parking permit fee is $23';

/** A small window, so the long guide can't be sent whole. */
async function smallWindow(sw: Worker) {
  await sw.evaluate(async () => {
    const key = 'tether:settings';
    const s = (await chrome.storage.local.get(key))[key] as Record<string, Record<string, unknown>>;
    await chrome.storage.local.set({
      [key]: { ...s, generation: { ...s.generation, numCtx: 1400, maxTokens: 200 } },
    });
  });
}

async function ask(panel: Page, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('local RAG', () => {
  test('sends the part of a long page that answers the question, found by embedding', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await smallWindow(serviceWorker);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/long-guide.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByTestId('chip-page').click();
      await expect(page.getByTestId('context-budget')).toContainText('trimmed to fit');
      const note = page.getByTestId('rag-note');
      await expect(note).toHaveAttribute('data-mode', 'retrieval');
      await expect(note).toContainText('nomic-embed-text');

      await ask(page, 'What is the overnight parking permit fee?');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment-retrieval')).toContainText('relevant parts');

      // The fact is near the end of the page: only retrieval gets it into the window.
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toContain(FACT);
      expect(user).toContain('[Long content: showing the');
      expect(user).toContain('<untrusted_page_content');
      expect(user).not.toMatch(/\[truncated: kept about/);
      expect(mock.requests.some((r) => r.path === '/api/embed')).toBe(true);

      // Asking again about the same page embeds only the question (vectors are cached).
      const embedsBefore = mock.requests.filter((r) => r.path === '/api/embed').length;
      await page.getByTestId('chip-page').click();
      await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'ready');
      await expect(page.getByTestId('rag-note')).toHaveAttribute('data-mode', 'retrieval');
      await ask(page, 'Where do I pay the parking permit?');
      // Retrieval runs before the new reply exists: wait for that reply, not the first.
      await expect(page.getByTestId('msg-assistant')).toHaveCount(2);
      await expect(page.getByTestId('msg-assistant').last()).toHaveAttribute('data-status', 'done');
      const newEmbeds = mock.requests.filter((r) => r.path === '/api/embed').slice(embedsBefore);
      expect(newEmbeds).toHaveLength(1);
      expect((newEmbeds[0]?.body as { input: string[] }).input).toEqual([
        'Where do I pay the parking permit?',
      ]);
    } finally {
      await mock.close();
    }
  });

  test('without an embedding model, sends the start and says how to fix it', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'llama3.2:3b', loaded: true, tools: true, contextLength: 131072 }],
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await smallWindow(serviceWorker);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/long-guide.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByTestId('chip-page').click();
      const note = page.getByTestId('rag-note');
      await expect(note).toHaveAttribute('data-mode', 'no-model');
      await expect(note).toContainText('ollama pull nomic-embed-text');

      await ask(page, 'What is the overnight parking permit fee?');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment')).toContainText('(trimmed)');
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toMatch(/\[truncated: kept about \d+ of \d+ tokens\]/);
      expect(user).not.toContain(FACT);
      expect(mock.requests.some((r) => r.path === '/api/embed')).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test('settings show the embedding model in use and can turn retrieval off', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await serviceWorker.evaluate(async () => {
        const key = 'tether:settings';
        const s = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
        await chrome.storage.local.set({
          [key]: { ...s, selection: { instanceId: 'ollama', model: 'llama3.2:3b' } },
        });
      });
      await page.goto(extensionUrl('options.html#pages'));
      const status = page.getByTestId('rag-status');
      await expect(status).toContainText('Using nomic-embed-text:latest');
      await expect(page.getByLabel('Embedding model')).toContainText('nomic-embed-text:latest');
      await page.getByRole('switch', { name: 'Find the relevant parts of long pages' }).click();
      await expect(status).toContainText('Off');
      const stored = await serviceWorker.evaluate(async () => {
        const v = (await chrome.storage.local.get('tether:settings'))['tether:settings'] as {
          rag: { enabled: boolean };
        };
        return v.rag.enabled;
      });
      expect(stored).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
