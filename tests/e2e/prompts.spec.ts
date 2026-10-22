/// <reference types="chrome" />
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

interface ChatBody {
  messages: { role: string; content: string }[];
}

function lastUserTurn(mock: { requests: { path: string; body: unknown }[] }): string {
  const bodies = mock.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as ChatBody);
  return bodies.at(-1)?.messages.at(-1)?.content ?? '';
}

test.describe('prompt library', () => {
  test('a slash command from the menu attaches the page and expands its template', async ({
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

      const box = page.getByLabel('Message', { exact: true });
      await box.fill('/su');
      const menu = page.getByTestId('slash-menu');
      await expect(menu.getByRole('option')).toHaveText([/\/summarize/]);
      await box.press('Enter');
      await expect(box).toHaveValue('/summarize ');
      await expect(menu).toBeHidden();
      await box.pressSequentially('focus on the animals');
      await box.press('Enter');

      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      await expect(page.getByTestId('msg-attachment')).toContainText(
        'The Hidden Life of Tidepools',
      );
      const user = lastUserTurn(mock);
      expect(user.startsWith('<untrusted_page_content source="page"')).toBe(true);
      expect(user).toContain('Ochre sea stars');
      expect(
        user.endsWith(
          '</untrusted_page_content>\n\nSummarize the page above in a few short paragraphs. focus on the animals',
        ),
      ).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('a command that needs a selection keeps the text when nothing is selected', async ({
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

      const box = page.getByLabel('Message', { exact: true });
      await box.fill('/explain');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('chip-selection')).toHaveAttribute('data-status', 'error');
      await expect(box).toHaveValue('/explain');
      expect(mock.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0);

      // Select a sentence on the page and try again.
      await site.evaluate(() => {
        const p = [...document.querySelectorAll('li')].find((x) => x.textContent.includes('Ochre'));
        if (!p) throw new Error('fixture changed');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      await page.getByTestId('chip-selection').click(); // clear the failed chip
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      const user = lastUserTurn(mock);
      expect(user.startsWith('<untrusted_page_content source="selection"')).toBe(true);
      expect(user).toContain('Ochre');
      expect(user.endsWith('Explain the selected text above in plain language.')).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('imports, validates, edits and exports the library; the panel follows', async ({
    page,
    extensionUrl,
    serviceWorker,
  }, info) => {
    const mock = await withMock({ flavor: 'ollama' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('options.html#prompts'));
      const list = page.getByTestId('prompt-list');
      await expect(list.getByTestId('prompt')).toHaveCount(7);

      // A bad file changes nothing and says why.
      const bad = info.outputPath('bad.json');
      writeFileSync(bad, JSON.stringify([{ command: 'Has Spaces', name: 'x', template: 'y' }]));
      await page.getByLabel('Import prompts file').setInputFiles(bad);
      await expect(page.getByTestId('prompt-notice')).toContainText('lowercase');
      await expect(page.getByTestId('prompt-notice')).toContainText('Nothing was changed');
      await expect(list.getByTestId('prompt')).toHaveCount(7);

      const good = info.outputPath('good.json');
      writeFileSync(
        good,
        JSON.stringify({
          format: 'tether-prompts',
          version: 1,
          prompts: [
            { command: 'haiku', name: 'Haiku', template: 'Write a haiku about {{input|the sea}}.' },
          ],
        }),
      );
      await page.getByLabel('Import prompts file').setInputFiles(good);
      await expect(page.getByTestId('prompt-notice')).toContainText('Imported 1 prompt');
      await expect(list.getByTestId('prompt')).toHaveCount(8);

      // Edit it in place.
      await page.getByRole('button', { name: 'Edit /haiku' }).click();
      await page
        .getByLabel('Template', { exact: true })
        .fill('Write a haiku about {{input|autumn}}.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(list).toContainText('Write a haiku about {{input|autumn}}.');

      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const file = await (await download).path();
      const exported = JSON.parse(readFileSync(file, 'utf8')) as {
        prompts: { command: string; template: string }[];
      };
      expect(exported.prompts.find((p) => p.command === 'haiku')?.template).toBe(
        'Write a haiku about {{input|autumn}}.',
      );

      // The panel offers it straight away.
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      const box = page.getByLabel('Message', { exact: true });
      await box.fill('/hai');
      await expect(page.getByTestId('slash-menu').getByRole('option')).toHaveText([/\/haiku/]);
      await box.fill('/haiku');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
      expect(lastUserTurn(mock)).toBe('Write a haiku about autumn.');

      // Reset brings back the built-ins only.
      await page.goto(extensionUrl('options.html#prompts'));
      await page.getByRole('button', { name: 'Reset to defaults' }).click();
      await expect(list.getByTestId('prompt')).toHaveCount(7);
    } finally {
      await mock.close();
    }
  });
});
