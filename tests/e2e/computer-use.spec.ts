/// <reference types="chrome" />
import type { Page } from '@playwright/test';
import type { MockChatBody, MockScriptReply } from '../fixtures/mock-llm/server';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

/** The latest observation the agent sent the model. */
function lastObservation(body: MockChatBody): string {
  const last = body.messages?.at(-1)?.content;
  return typeof last === 'string' ? last : '';
}
const pageUrl = (body: MockChatBody) => /^URL: (\S+)/m.exec(lastObservation(body))?.[1] ?? '';
/** Element id of the first element with this accessible name in the latest snapshot. */
function idOf(body: MockChatBody, name: string): string | undefined {
  const escaped = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\[([\\d.]+)\\] <[^>]+> ${escaped}`, 'm').exec(lastObservation(body))?.[1];
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

const SHIPPING = {
  name: 'Robin Park',
  address: '12 Alder St',
  city: 'Portland',
  zip: '97201',
  country: 'US',
  method: 'standard',
};

/** Open the checkout review page with shipping details already entered. */
async function openReview(page: Page, sitesUrl: string) {
  await page.goto(`${sitesUrl}/apps/checkout/cart.html`);
  await page.evaluate((s) => {
    sessionStorage.setItem('checkout:shipping', JSON.stringify(s));
  }, SHIPPING);
  await page.goto(`${sitesUrl}/apps/checkout/review.html`);
}

test.describe('agent (computer use)', () => {
  for (const approve of [true, false]) {
    test(`asks before placing an order and ${approve ? 'places it when allowed' : 'does nothing when denied'}`, async ({
      context,
      page,
      extensionUrl,
      serviceWorker,
      sitesUrl,
    }) => {
      let declined = false;
      const mock = await withMock({
        flavor: 'ollama',
        models: [{ id: 'agent-model', loaded: true, tools: true }],
        script: (body) => {
          if (pageUrl(body).endsWith('/checkout/confirmation.html'))
            return call('done', { summary: 'Order placed.' });
          if (JSON.stringify(body.messages).includes('declined')) {
            declined = true;
            return call('done', { summary: 'The order was not placed.' });
          }
          const place = idOf(body, 'Place order');
          if (place && pageUrl(body).endsWith('/checkout/review.html'))
            return call('click', { id: place });
          return undefined;
        },
      });
      try {
        await configureProviders(serviceWorker, [
          { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
        ]);
        const site = await context.newPage();
        await openReview(site, sitesUrl);
        await page.goto(extensionUrl('sidepanel.html'));
        await expect(page.getByTestId('model-picker')).toContainText('agent-model');
        await runTask(page, 'Place my order');

        const confirm = page.getByTestId('agent-confirm');
        await expect(confirm).toBeVisible({ timeout: 20_000 });
        await expect(confirm).toContainText('Place order');
        // Nothing has happened yet: the click is held until the user answers.
        expect(await site.evaluate(() => sessionStorage.getItem('checkout:order'))).toBeNull();
        await confirm.getByRole('button', { name: approve ? 'Allow once' : 'Don’t allow' }).click();

        const run = page.getByTestId('agent-run');
        await expect(run).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
        await expect(confirm).toBeHidden();
        const order = await site.evaluate(() => sessionStorage.getItem('checkout:order'));
        if (approve) {
          expect(order).not.toBeNull();
          await expect(site).toHaveURL(/confirmation\.html$/);
        } else {
          expect(order).toBeNull();
          expect(declined).toBe(true);
          await expect(
            run.locator('[data-testid="agent-step"][data-outcome="declined"]'),
          ).toHaveCount(1);
        }
      } finally {
        await mock.close();
      }
    });
  }

  test('fills a form field but refuses to type into a password field', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    let tried = false;
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'agent-model', loaded: true, tools: true }],
      script: (body) => {
        const all = JSON.stringify(body.messages);
        const email = idOf(body, 'Email');
        const password = idOf(body, 'Password');
        if (!all.includes('robin@example.com') && email)
          return call('type', { id: email, text: 'robin@example.com' });
        if (!tried && password) {
          tried = true;
          return call('type', { id: password, text: 'hunter22' });
        }
        return call('askUser', { question: 'Please sign in yourself; I can’t enter passwords.' });
      },
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/apps/login/index.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('agent-model');
      await runTask(page, 'Sign me in');

      const run = page.getByTestId('agent-run');
      await expect(run).toHaveAttribute('data-status', 'needs-user', { timeout: 20_000 });
      const steps = run.getByTestId('agent-step');
      await expect(steps.nth(0)).toHaveAttribute('data-outcome', 'ok');
      await expect(steps.nth(1)).toHaveAttribute('data-outcome', 'blocked');
      await expect(steps.nth(1)).toContainText(/password/i);
      await expect(site.locator('#email')).toHaveValue('robin@example.com');
      await expect(site.locator('#password')).toHaveValue('');
      expect(await site.evaluate(() => localStorage.getItem('login:passwordTyped'))).toBeNull();
    } finally {
      await mock.close();
    }
  });

  test('shows the control banner on the tab and Esc there stops the run; the run is in the trace viewer', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      models: [{ id: 'agent-model', loaded: true, tools: true }],
      script: () => call('waitFor', { condition: 'never appears', timeoutMs: 1500 }),
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      const site = await context.newPage();
      await site.goto(`${sitesUrl}/apps/todo/index.html`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('agent-model');
      await runTask(page, 'Wait for something');

      await expect(page.getByTestId('agent-step').first()).toBeVisible({ timeout: 10_000 });
      const banner = site.locator('tether-agent-banner');
      await expect(banner).toHaveCount(1, { timeout: 10_000 });
      // A page script can't stop the run: synthetic key events are ignored.
      await site.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      await expect(banner).toHaveCount(1);

      await site.bringToFront();
      await site.keyboard.press('Escape');
      const run = page.getByTestId('agent-run');
      await expect(run).toHaveAttribute('data-status', 'stopped', { timeout: 10_000 });
      await expect(banner).toHaveCount(0);

      // The trace viewer lists the run and its steps.
      await page.goto(extensionUrl('options.html#runs'));
      const runs = page.getByTestId('run');
      await expect(runs).toHaveCount(1);
      await runs.first().getByRole('button').first().click();
      await expect(page.getByTestId('run-step').first()).toContainText('waitFor');
    } finally {
      await mock.close();
    }
  });
});
