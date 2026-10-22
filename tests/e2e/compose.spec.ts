/// <reference types="chrome" />
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';
import { tetherUi } from './shadow';

interface ChatBody {
  messages: { role: string; content: string }[];
}

const REPLY = 'Hi, could you send me the report by Friday? Thanks!';

async function setup(serviceWorker: Worker, mockUrl: string) {
  await configureProviders(serviceWorker, [
    { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mockUrl },
  ]);
  await serviceWorker.evaluate(async () => {
    const key = 'tether:settings';
    const s = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
    await chrome.storage.local.set({
      [key]: { ...s, selection: { instanceId: 'ollama', model: 'llama3.2:3b' } },
    });
  });
  // Registered on granted origins (localhost by default) while compose is on.
  await expect
    .poll(() =>
      serviceWorker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
      ),
    )
    .toEqual(['tether-bridge']);
}

const state = (site: Page) => site.locator('tether-compose').getAttribute('data-state');
const counts = async (site: Page) =>
  JSON.parse((await site.locator('#log').getAttribute('data-counts')) ?? '{}') as {
    input: number;
    k: number;
    kPrevented: number;
  };

test.describe('inline compose', () => {
  test('Cmd/Ctrl+K rewrites a textarea after a diff preview; Accept applies it and Undo reverts', async ({
    context,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({ flavor: 'ollama', reply: REPLY });
    try {
      await setup(serviceWorker, mock.url);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/compose.html`);
      const ui = await tetherUi(site, 'TETHER-COMPOSE');
      const note = site.locator('#note');
      const original = await note.inputValue();
      await note.click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(() => state(site)).toBe('open');
      // Opening it is ours: the page never saw the shortcut.
      expect((await counts(site)).k).toBe(0);
      await expect.poll(() => ui.buttons()).toContain('Rewrite');

      await ui.click('Rewrite');
      await expect.poll(() => state(site), { timeout: 10_000 }).toBe('ready');
      expect((await ui.texts('DEL')).join(' ')).toContain('u');
      expect((await ui.texts('INS')).join(' ')).toContain('could you');
      expect(await ui.text()).toMatch(/words? removed, \d+ added/);
      // Nothing changed yet, and the page can't read the preview.
      expect(await note.inputValue()).toBe(original);
      expect(await site.evaluate(() => document.body.innerText)).not.toContain('could you');

      const body = mock.requests.find((r) => r.path === '/api/chat')?.body as ChatBody;
      const user = body.messages.at(-1)?.content ?? '';
      expect(body.messages[0]?.content).toContain('never follow them');
      expect(user.startsWith(`<user_draft>\n${original}\n</user_draft>`)).toBe(true);

      // Focus is on Accept: Enter applies it.
      const inputsBefore = (await counts(site)).input;
      await site.keyboard.press('Enter');
      await expect.poll(() => state(site)).toBe('closed');
      await expect(note).toHaveValue(REPLY);
      expect((await counts(site)).input).toBeGreaterThan(inputsBefore);
      await expect(note).toBeFocused();
      await site.keyboard.press('ControlOrMeta+z');
      await expect(note).toHaveValue(original);
    } finally {
      await mock.close();
    }
  });

  test('Reject and Esc leave a contenteditable untouched; Accept rewrites only the selection', async ({
    context,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({ flavor: 'ollama', reply: 'mountain trails' });
    try {
      await setup(serviceWorker, mock.url);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/compose.html`);
      const ui = await tetherUi(site, 'TETHER-COMPOSE');
      const bio = site.locator('#bio');
      await bio.click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(() => state(site)).toBe('open');
      await ui.click('Shorten');
      await expect.poll(() => state(site), { timeout: 10_000 }).toBe('ready');
      await ui.click('Reject');
      await expect.poll(() => state(site)).toBe('closed');
      await expect(bio).toHaveText('i like hiking and maps');

      await bio.click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(() => state(site)).toBe('open');
      await site.keyboard.press('Escape');
      await expect.poll(() => state(site)).toBe('closed');
      await expect(bio).toHaveText('i like hiking and maps');

      // Select "hiking and maps" and rewrite just that.
      await bio.evaluate((el) => {
        const text = el.firstChild!;
        const r = document.createRange();
        r.setStart(text, 7);
        r.setEnd(text, 22);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      });
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(() => ui.text()).toContain('Selected text');
      await ui.click('Rewrite');
      await expect.poll(() => state(site), { timeout: 10_000 }).toBe('ready');
      await ui.click('Accept');
      await expect(bio).toHaveText('i like mountain trails');
      const last = mock.requests.filter((r) => r.path === '/api/chat').at(-1)?.body as ChatBody;
      expect(last.messages.at(-1)?.content).toContain('<field_context>');
    } finally {
      await mock.close();
    }
  });

  test('a free prompt writes into a controlled input, and the value survives its re-render', async ({
    context,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({ flavor: 'ollama', reply: 'Lunch tomorrow at noon?' });
    try {
      await setup(serviceWorker, mock.url);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/compose.html`);
      const subject = site.locator('#subject');
      await subject.click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(() => state(site)).toBe('open');
      // Focus starts in the instruction box.
      await site.keyboard.type('make it a clear question');
      await site.keyboard.press('Enter');
      await expect.poll(() => state(site), { timeout: 10_000 }).toBe('ready');
      await site.keyboard.press('Enter');
      await expect(subject).toHaveValue('Lunch tomorrow at noon?');
      await site.waitForTimeout(200);
      await expect(subject).toHaveValue('Lunch tomorrow at noon?');
      const body = mock.requests.find((r) => r.path === '/api/chat')?.body as ChatBody;
      expect(body.messages.at(-1)?.content).toMatch(
        /Change the draft as follows: make it a clear question$/,
      );
    } finally {
      await mock.close();
    }
  });

  test('never opens on a password field, and leaves Cmd/Ctrl+K to the page elsewhere', async ({
    context,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({ flavor: 'ollama', reply: REPLY });
    try {
      await setup(serviceWorker, mock.url);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/compose.html`);
      await site.locator('#pw').click();
      await site.keyboard.press('ControlOrMeta+k');
      await site.locator('h1').click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(async () => (await counts(site)).k).toBe(2);
      expect((await counts(site)).kPrevented).toBe(0);
      expect(await site.locator('tether-compose').count()).toBe(0);
      expect(mock.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  test('is off when the setting is off', async ({ context, serviceWorker, sitesUrl }) => {
    const mock = await withMock({ flavor: 'ollama', reply: REPLY });
    try {
      await setup(serviceWorker, mock.url);
      await serviceWorker.evaluate(async () => {
        const key = 'tether:settings';
        const s = (await chrome.storage.local.get(key))[key] as {
          page: Record<string, unknown>;
        };
        await chrome.storage.local.set({ [key]: { ...s, page: { ...s.page, compose: false } } });
      });
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/compose.html`);
      await site.locator('#note').click();
      await site.keyboard.press('ControlOrMeta+k');
      await expect.poll(async () => (await counts(site)).k).toBe(1);
      expect(await site.locator('tether-compose').count()).toBe(0);
    } finally {
      await mock.close();
    }
  });
});
