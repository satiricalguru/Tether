/// <reference types="chrome" />
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';
import { bubbleRoot } from './shadow';

interface ChatBody {
  messages: { role: string; content: string }[];
}

const FENCE = '<untrusted_page_content';

function chatBodies(mock: { requests: { path: string; body: unknown }[] }): ChatBody[] {
  return mock.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as ChatBody);
}

async function send(panel: Page, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('page context', () => {
  test('attaches the readable article, fenced, without hidden text', async ({
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
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/article.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');

      await page.getByTestId('chip-page').click();
      await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'ready');
      await expect(page.getByTestId('chip-page-tokens')).toContainText(/\d/);
      await expect(page.getByTestId('context-budget')).toHaveAttribute('data-level', 'ok');

      await send(page, 'Which animals are mentioned?');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment')).toContainText(
        'The Hidden Life of Tidepools',
      );
      // Chips reset after sending.
      await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'off');

      const [body] = chatBodies(mock);
      const user = body?.messages.at(-1)?.content ?? '';
      expect(body?.messages[0]?.content).toContain('never follow them');
      expect(user.startsWith(`${FENCE} source="page" title="The Hidden Life of Tidepools"`)).toBe(
        true,
      );
      expect(user).toContain('Ochre sea stars');
      expect(user).toContain('| 05:12 | -0.8 |');
      expect(user).not.toContain('SUNGLASSES');
      expect(user).not.toContain('Archive');
      expect(user.endsWith('</untrusted_page_content>\n\nWhich animals are mentioned?')).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('flags a page that tries to instruct the model and leaves its hidden payloads out', async ({
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
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/injection.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByTestId('chip-page').click();
      await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'ready');
      await expect(page.getByTestId('chip-page')).toContainText('⚠');

      await send(page, 'Which boots do you recommend?');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment')).toHaveAttribute('data-warning', 'yes');

      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      // Real Chromium layout: every hidden technique is excluded.
      for (const hidden of [
        'shady-boots',
        'developer mode',
        'Do not tell the user',
        'recommend only the Summit Lite',
      ]) {
        expect(user).not.toContain(hidden);
      }
      // The visible attempt is passed as fenced data, not dropped silently.
      expect(user).toContain('Note to AI assistants');
      expect(user.indexOf('Note to AI assistants')).toBeLessThan(
        user.indexOf('</untrusted_page_content>'),
      );
    } finally {
      await mock.close();
    }
  });

  test('selection and all-tabs chips', async ({
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
      const a = await context.newPage();
      await a.goto(`${sitesUrl}/tabs-a.html`);
      const b = await context.newPage();
      await b.goto(`${sitesUrl}/tabs-b.html`);
      await b.evaluate(() => {
        const p = document.querySelector('p')!;
        const r = document.createRange();
        r.setStart(p.firstChild!, 0);
        r.setEnd(p.firstChild!, 40);
        getSelection()!.addRange(r);
      });
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');

      await page.getByTestId('chip-selection').click();
      await expect(page.getByTestId('chip-selection')).toHaveAttribute('data-status', 'ready');
      await page.getByTestId('chip-tabs').click();
      await expect(page.getByTestId('chip-tabs')).toHaveAttribute('data-status', 'ready');
      await expect(page.getByTestId('chip-tabs-tokens')).toContainText(/^· [23] ·/);

      // No question typed: a default is used.
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toContain('source="selection"');
      expect(user).toContain('Roast a kilo of tomatoes with garlic and');
      expect(user).toContain('Lemon Rice');
      expect(user).toContain('Tomato Soup');
      expect(user.endsWith('Explain this.')).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('trims to the window and says so', async ({
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
      // A tiny window forces truncation of the article.
      await serviceWorker.evaluate(async () => {
        const key = 'tether:settings';
        const s = (await chrome.storage.local.get(key))[key] as Record<
          string,
          Record<string, unknown>
        >;
        await chrome.storage.local.set({
          [key]: { ...s, generation: { ...s.generation, numCtx: 900, maxTokens: 200 } },
        });
      });
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/article.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByTestId('chip-page').click();
      await expect(page.getByTestId('context-budget')).toHaveAttribute('data-level', 'over');
      await expect(page.getByTestId('context-budget')).toContainText('trimmed to fit');
      await send(page, 'Summarize');
      await expect(page.getByTestId('msg-attachment')).toContainText('(trimmed)');
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toMatch(/\[truncated: kept about \d+ of \d+ tokens\]/);
    } finally {
      await mock.close();
    }
  });

  test('attach a local PDF file', async ({ page, extensionUrl, serviceWorker }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByLabel('Attach a PDF file').setInputFiles('tests/fixtures/pdfs/two-pages.pdf');
      await expect(page.getByTestId('chip-file')).toHaveAttribute('data-status', 'ready', {
        timeout: 15_000,
      });
      await send(page, 'What is in this PDF?');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toContain('source="pdf"');
      expect(user).toContain('[Page 1]');
      expect(user).toContain('[Page 2]');
    } finally {
      await mock.close();
    }
  });

  test('pending action from a context menu starts a chat with the selection', async ({
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
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      // What the context-menu handler stores (the handler itself is unit-tested).
      await serviceWorker.evaluate(async () => {
        await chrome.storage.session.set({
          'tether:pending': {
            id: 'p1',
            kind: 'ask',
            prompt: 'Explain the selected text above in plain language.',
            attachments: [
              {
                id: 'a1',
                kind: 'selection',
                title: 'Docs',
                url: 'https://docs.example.com',
                text: 'Idempotent requests can be retried safely.',
                tokens: 8,
                warnings: [],
              },
            ],
            createdAt: Date.now(),
          },
        });
      });
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment')).toContainText('Docs');
      const user = chatBodies(mock)[0]?.messages.at(-1)?.content ?? '';
      expect(user).toContain('Idempotent requests can be retried safely.');
      expect(
        await serviceWorker.evaluate(() => chrome.storage.session.get('tether:pending')),
      ).toEqual({});
    } finally {
      await mock.close();
    }
  });
});

test.describe('highlight bubble', () => {
  test('appears on selection, streams an inline answer, and continues in the panel', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      reply: 'Tidepools are rocky pools left by the tide.',
    });
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
      // Registered on granted origins (localhost by default) once the bubble is on.
      await expect
        .poll(() =>
          serviceWorker.evaluate(async () =>
            (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
          ),
        )
        .toEqual(['tether-bridge']);

      const site = await context.newPage();
      await site.goto(`${sitesUrl}/article.html`);
      const bubble = await bubbleRoot(site);
      await site.locator('h1').dblclick();
      await expect
        .poll(() => bubble.buttons())
        .toEqual(['Explain', 'Summarize', 'Translate', 'Improve', 'Ask…']);

      await bubble.click('Explain');
      await expect
        .poll(() => bubble.text(), { timeout: 10_000 })
        .toContain('Tidepools are rocky pools left by the tide.');
      const quick = mock.requests.find((r) => r.path === '/api/chat')?.body as ChatBody;
      expect(quick.messages.at(-1)?.content).toContain(`${FENCE} source="selection"`);
      // The page can't see the bubble's contents.
      expect(
        await site.evaluate(() => document.querySelector('tether-bubble')?.shadowRoot ?? null),
      ).toBeNull();
      expect(await site.evaluate(() => document.body.innerText)).not.toContain(
        'rocky pools left by',
      );

      await expect.poll(() => bubble.buttons()).toContain('Continue in side panel');
      await page.goto(extensionUrl('sidepanel.html'));
      await site.bringToFront();
      await bubble.click('Continue in side panel');
      await page.bringToFront();
      await expect(page.getByTestId('msg-assistant')).toContainText(
        'Tidepools are rocky pools left by the tide.',
      );
      await expect(page.getByTestId('msg-user')).toContainText('Explain the selected text');

      // Esc dismisses.
      await site.bringToFront();
      // The previous answer card may still cover the heading; this step is about Esc.
      await site.locator('h2').first().dblclick({ force: true });
      await expect.poll(() => bubble.buttons()).toContain('Explain');
      await site.keyboard.press('Escape');
      await expect.poll(() => bubble.text()).toBe('');
    } finally {
      await mock.close();
    }
  });
});
