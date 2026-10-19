/// <reference types="chrome" />
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

const MD_REPLY = [
  'Here is **bold** and a list:',
  '',
  '- one',
  '- two',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '![tracker](https://tracker.example/pixel.gif) and [a link](javascript:alert(1)).',
].join('\n');

interface ChatBody {
  model: string;
  messages: { role: string; content: string }[];
  options?: Record<string, unknown>;
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const assistant = (page: Page) => page.getByTestId('msg-assistant');

test.describe('chat', () => {
  test('streams markdown with highlighted code, loads no remote content, keeps the worker alive', async ({
    page,
    context,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama', reply: MD_REPLY, tokenDelayMs: 15 });
    const external: string[] = [];
    context.on('request', (r) => {
      const u = new URL(r.url());
      if (
        !['chrome-extension:', 'data:', 'blob:'].includes(u.protocol) &&
        u.hostname !== '127.0.0.1'
      ) {
        external.push(r.url());
      }
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await send(page, 'Show me markdown');
      await expect(assistant(page)).toHaveAttribute('data-status', 'streaming');
      await expect
        .poll(() => serviceWorker.evaluate(() => chrome.alarms.get('tether:keepalive')))
        .toBeTruthy();
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');

      const md = assistant(page).getByTestId('markdown');
      await expect(md.locator('strong')).toHaveText('bold');
      await expect(md.locator('li')).toHaveCount(2);
      const code = md.getByTestId('code-block');
      await expect(code).toHaveAttribute('data-lang', 'ts');
      await expect(code).toContainText('const answer: number = 42;');
      // Highlighted: token spans carry theme colors.
      await expect.poll(() => code.locator('.md-token').count()).toBeGreaterThan(3);
      // Never an <img>, never a javascript: href.
      await expect(md.locator('img')).toHaveCount(0);
      await expect(md.getByTestId('image-chip')).toBeVisible();
      await expect(md.locator('a[href^="javascript"]')).toHaveCount(0);
      await expect(assistant(page).getByTestId('metrics')).toContainText('tok/s');
      await expect(page.getByTestId('panel-title')).toHaveText('Show me markdown');
      expect(external).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  test('stop keeps the partial reply, Esc stops too, and the prompt is not resent', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const reply = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const mock = await withMock({ flavor: 'openai', reply, tokenDelayMs: 25 });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'box', kind: 'openai-compatible', label: 'Box', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('Qwen');
      await send(page, 'go');
      await expect(assistant(page)).toContainText('w3');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(assistant(page)).toHaveAttribute('data-status', 'stopped');
      const partial = (await assistant(page).getByTestId('markdown').textContent()) ?? '';
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan(reply.length);

      await send(page, 'again');
      await expect(assistant(page).nth(1)).toContainText('w3');
      await page.keyboard.press('Escape');
      await expect(assistant(page).nth(1)).toHaveAttribute('data-status', 'stopped');
      expect(mock.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  test('regenerate creates a sibling, edit-and-resend branches, versions are navigable', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await send(page, 'first question');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');

      await assistant(page).getByRole('button', { name: 'Regenerate' }).click();
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');
      await expect(assistant(page).getByTestId('sibling-pos')).toHaveText('2/2');
      await assistant(page).getByRole('button', { name: 'Previous version' }).click();
      await expect(assistant(page).getByTestId('sibling-pos')).toHaveText('1/2');

      const user = page.getByTestId('msg-user');
      await user.getByRole('button', { name: 'Edit and resend' }).click();
      await page.getByLabel('Edit message').fill('edited question');
      await page.getByLabel('Edit message').press('Enter');
      await expect(user).toContainText('edited question');
      await expect(user.getByTestId('sibling-pos')).toHaveText('2/2');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');
      // The original question and both of its answers are still there; going
      // back shows that question's newest answer.
      await user.getByRole('button', { name: 'Previous version' }).click();
      await expect(user).toContainText('first question');
      await expect(assistant(page).getByTestId('sibling-pos')).toHaveText('2/2');

      const chats = mock.requests
        .filter((r) => r.path === '/api/chat')
        .map((r) => r.body as ChatBody);
      expect(chats).toHaveLength(3);
      expect(chats[2]?.messages.at(-1)).toEqual({ role: 'user', content: 'edited question' });
      expect(chats[2]?.messages.some((m) => m.content === 'first question')).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test('reasoning is hidden by default, shown on demand, and never sent back', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'mock-think', loaded: true, thinking: true }],
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('mock-think');
      await send(page, 'think about it');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');
      await expect(assistant(page).getByTestId('reasoning')).toHaveCount(0);
      await expect(assistant(page).getByTestId('markdown')).not.toContainText('Let me think');
      await assistant(page).getByTestId('reasoning-toggle').click();
      await expect(assistant(page).getByTestId('reasoning')).toHaveText('Let me think.');

      await send(page, 'and again');
      await expect(assistant(page).nth(1)).toHaveAttribute('data-status', 'done');
      const second = mock.requests.filter((r) => r.path === '/api/chat')[1]?.body as ChatBody;
      expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(JSON.stringify(second.messages)).not.toContain('Let me think');
    } finally {
      await mock.close();
    }
  });

  test('cold model shows loading state inside the chat', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama', models: [{ id: 'mock-cold' }] });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('mock-cold');
      await send(page, 'wake up');
      await expect(page.getByTestId('msg-status')).toHaveAttribute('data-status', 'loading-model');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
      await expect(assistant(page).getByTestId('metrics')).toContainText('load');
    } finally {
      await mock.close();
    }
  });
});

test.describe('history', () => {
  test('persists across reloads; search, pin, rename, export and delete', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await send(page, 'Rust lifetimes');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await send(page, 'Python decorators');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');

      await page.reload();
      await page.getByRole('button', { name: 'History' }).click();
      const items = page.getByTestId('history-item');
      await expect(items).toHaveCount(2);
      await expect(items.first()).toContainText('Python decorators');

      await page.getByLabel('Search conversations').fill('rust');
      await expect(items).toHaveCount(1);
      // Message text is searched too, not just titles.
      await page.getByLabel('Search conversations').fill('mock model');
      await expect(items).toHaveCount(2);
      await page.getByLabel('Search conversations').fill('');

      const rust = items.filter({ hasText: 'Rust lifetimes' });
      await rust.hover();
      await rust.getByRole('button', { name: 'Pin' }).click();
      await expect(items.first()).toContainText('Rust lifetimes');

      await rust.hover();
      await rust.getByRole('button', { name: 'Rename' }).click();
      await page.getByLabel('Conversation title').fill('Borrow checker');
      await page.getByLabel('Conversation title').press('Enter');
      await expect(items.first()).toContainText('Borrow checker');

      await items.first().hover();
      const download = page.waitForEvent('download');
      await items.first().getByRole('button', { name: 'Export as Markdown' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('Borrow-checker.md');

      const py = items.filter({ hasText: 'Python decorators' });
      await py.hover();
      await py.getByRole('button', { name: 'Delete' }).click();
      await py.getByRole('button', { name: 'Delete?' }).click();
      await expect(items).toHaveCount(1);

      await items.first().getByRole('button').first().click();
      await expect(page.getByTestId('msg-user')).toContainText('Rust lifetimes');
    } finally {
      await mock.close();
    }
  });
});

test.describe('chat settings', () => {
  test('generation defaults from the settings page reach the request', async ({
    page,
    context,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      const options = await context.newPage();
      await options.goto(extensionUrl('options.html#chat'));
      await options.getByLabel('Temperature').fill('0.15');
      await options.getByLabel('Temperature').press('Enter');
      await options.getByLabel('Seed').fill('1234');
      await options.getByLabel('Seed').press('Enter');
      await options.getByLabel('System prompt').fill('Answer like a pirate.');
      await options.getByLabel('System prompt').blur();
      await options.close();

      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await send(page, 'hello');
      await expect(assistant(page)).toHaveAttribute('data-status', 'done');
      const body = mock.requests.find((r) => r.path === '/api/chat')?.body as ChatBody;
      expect(body.options).toMatchObject({ temperature: 0.15, seed: 1234 });
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Answer like a pirate.' });

      // Per-chat override beats the default.
      await page.getByRole('button', { name: 'Chat settings' }).click();
      await page.getByLabel('Temperature').fill('1.2');
      await page.getByRole('button', { name: 'Save' }).click();
      await send(page, 'again');
      await expect(assistant(page).nth(1)).toHaveAttribute('data-status', 'done');
      const second = mock.requests.filter((r) => r.path === '/api/chat')[1]?.body as ChatBody;
      expect(second.options).toMatchObject({ temperature: 1.2 });
    } finally {
      await mock.close();
    }
  });
});
