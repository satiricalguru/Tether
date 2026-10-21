/// <reference types="chrome" />
import type { Page } from '@playwright/test';
import type { MockChatBody, MockScriptReply } from '../fixtures/mock-llm/server';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

/** Current URL as the agent's prompt reports it. */
function pageUrl(body: MockChatBody): string {
  const last = body.messages?.at(-1)?.content;
  return typeof last === 'string' ? (/^URL: (\S+)/m.exec(last)?.[1] ?? '') : '';
}
const call = (name: string, args: Record<string, unknown>): MockScriptReply => ({
  toolCalls: [{ name, arguments: args }],
});

async function runTask(page: Page, task: string) {
  const agentToggle = page.getByRole('button', { name: 'Agent mode' });
  if ((await agentToggle.getAttribute('aria-pressed')) !== 'true') await agentToggle.click();
  await page.getByLabel('Message', { exact: true }).fill(task);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('agent (read-only tools)', () => {
  test('navigates between pages, waits for late content, answers, and traces every step', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'agent-model', loaded: true, tools: true }],
      script: (body) => {
        const url = pageUrl(body);
        if (url.endsWith('/shop/index.html'))
          return call('navigate', { url: `${sitesUrl}/shop/granite.html` });
        if (url.endsWith('/shop/granite.html'))
          return call('navigate', { url: `${sitesUrl}/trails/conditions.html` });
        if (url.endsWith('/trails/conditions.html')) {
          const content = JSON.stringify(body.messages);
          if (!content.includes('Ranger report'))
            return call('waitFor', { condition: 'Ranger report', timeoutMs: 5000 });
          return call('done', {
            summary: 'The Granite GTX costs $159, and the Ridge Loop is closed today.',
          });
        }
        return undefined;
      },
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/shop/index.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('agent-model');
      await runTask(page, 'What does the Granite GTX cost, and is the Ridge Loop open today?');

      const run = page.getByTestId('agent-run');
      await expect(run).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
      await expect(page.getByTestId('agent-tier')).toContainText('native tools');
      await expect(run.getByTestId('agent-step')).toHaveCount(4);
      expect(
        await run
          .getByTestId('agent-step')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-action'))),
      ).toEqual(['navigate', 'navigate', 'waitFor', 'done']);
      await expect(page.getByTestId('msg-assistant').getByTestId('markdown')).toContainText(
        'Ridge Loop is closed today',
      );

      // The agent drove the real tab.
      expect(site.url()).toBe(`${sitesUrl}/trails/conditions.html`);
      // Every step is in the trace store.
      const traces = await page.evaluate(async () => {
        const open = indexedDB.open('tether');
        const db = await new Promise<IDBDatabase>((res) => {
          open.onsuccess = () => res(open.result);
        });
        return new Promise<string[]>((res) => {
          const req = db.transaction('traces').objectStore('traces').getAll();
          req.onsuccess = () =>
            res(
              (req.result as { step: number; action: string }[])
                .sort((a, b) => a.step - b.step)
                .map((t) => t.action),
            );
        });
      });
      expect(traces).toEqual(['navigate', 'navigate', 'waitFor', 'done']);
      // Page text reached the model fenced as untrusted data.
      const lastBody = mock.requests.filter((r) => r.path === '/api/chat').at(-1)
        ?.body as MockChatBody;
      expect(JSON.stringify(lastBody.messages)).toContain('untrusted_page_content');
    } finally {
      await mock.close();
    }
  });

  test('refuses a default-blocked site and stop ends a run', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    let calls = 0;
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'agent-model', loaded: true, tools: true }],
      script: () => {
        calls += 1;
        // First a blocked site, then keep waiting forever until stopped.
        return calls === 1
          ? call('navigate', { url: 'https://www.paypal.com/signin' })
          : call('waitFor', { condition: 'never appears', timeoutMs: 15000 });
      },
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/shop/index.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('agent-model');
      await runTask(page, 'Log into PayPal');

      const steps = page.getByTestId('agent-step');
      await expect(steps.first()).toHaveAttribute('data-outcome', 'blocked');
      await expect(steps.first()).toContainText('payments site');
      expect(site.url()).toBe(`${sitesUrl}/shop/index.html`);

      await expect(page.getByTestId('agent-working')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('agent-run')).toHaveAttribute('data-status', 'stopped');
      await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'stopped');
    } finally {
      await mock.close();
    }
  });
});
