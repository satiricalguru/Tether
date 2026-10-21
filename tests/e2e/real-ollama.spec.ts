/// <reference types="chrome" />
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from './fixtures';
import { configureProviders } from './helpers';

/**
 * Opt-in: the real extension against a real Ollama and model.
 *
 *   TETHER_REAL_OLLAMA=1 TETHER_REAL_MODEL=ornith-1.5:9b pnpm e2e:real
 *
 * Never changes the system's OLLAMA_ORIGINS: it starts a temporary second
 * `ollama serve` on :11435 with the variable set for that process only, and
 * stops it afterwards. The model already resident in the main instance is
 * unloaded first so two copies don't compete for memory.
 */

const ENABLED = process.env.TETHER_REAL_OLLAMA === '1';
const MODEL = process.env.TETHER_REAL_MODEL ?? 'ornith-1.5:9b';
const MAIN = 'http://127.0.0.1:11434';
const TEMP_PORT = 11435;
const TEMP = `http://127.0.0.1:${TEMP_PORT}`;

test.describe('real Ollama', () => {
  test.skip(!ENABLED, 'set TETHER_REAL_OLLAMA=1 to run against a local Ollama');
  test.describe.configure({ timeout: 240_000 });

  let server: ChildProcess | undefined;

  test.beforeAll(async () => {
    await fetch(`${MAIN}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    }).catch(() => undefined);
    server = spawn('ollama', ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${TEMP_PORT}`,
        OLLAMA_ORIGINS: 'chrome-extension://*',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(`${TEMP}/api/version`).then(
          (r) => r.ok,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('temporary ollama serve did not start');
  });

  test.afterAll(async () => {
    await fetch(`${TEMP}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    }).catch(() => undefined);
    server?.kill('SIGTERM');
  });

  test('the Doctor reads the main instance correctly (blocked unless OLLAMA_ORIGINS allows it)', async ({
    page,
    extensionUrl,
    extensionId,
    serviceWorker,
  }) => {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: MAIN },
    ]);
    await page.goto(extensionUrl('options.html'));
    const row = page.getByTestId('doctor-ollama');
    await expect(row).not.toHaveAttribute('data-diagnosis', 'disabled');
    await expect
      .poll(async () => row.getAttribute('data-diagnosis'), { timeout: 10_000 })
      .toMatch(/^(origin-blocked|ok|unreachable)$/);
    // Only meaningful when the user's own Ollama is running.
    test.skip(
      (await row.getAttribute('data-diagnosis')) === 'unreachable',
      'main Ollama on :11434 is not running',
    );
    if ((await row.getAttribute('data-diagnosis')) === 'origin-blocked') {
      await expect(row).toContainText(`OLLAMA_ORIGINS "chrome-extension://${extensionId}"`);
    }
  });

  test('streams a real reply with metrics and lists real capabilities', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: TEMP },
    ]);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('model-picker')).toContainText(MODEL, { timeout: 20_000 });

    await page.getByLabel('Message', { exact: true }).fill('Reply with exactly: Tether works');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const reply = page.getByTestId('msg-assistant');
    // Cold load first: the watchdog must say so rather than look hung.
    await expect(page.getByTestId('msg-status')).toHaveAttribute('data-status', 'loading-model', {
      timeout: 15_000,
    });
    await expect(reply).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
    await expect(reply.getByTestId('markdown')).toContainText('Tether works');
    const metrics = reply.getByTestId('metrics');
    for (const label of ['TTFT', 'tok/s', 'prompt', 'context', 'load']) {
      await expect(metrics).toContainText(label);
    }
    console.log('real metrics:', await metrics.textContent());

    // Capabilities as Ollama reports them.
    const models: unknown = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        __tether: 1,
        type: 'bg:providers:models',
        payload: { instanceId: 'ollama' },
      }),
    );
    const model = (
      models as { value: { id: string; capabilities?: Record<string, unknown> }[] }
    ).value.find((m) => m.id === MODEL);
    console.log('real capabilities:', JSON.stringify(model?.capabilities));
    expect(typeof model?.capabilities?.contextLength).toBe('number');
    // The footer reports the window Ollama is actually running, not the model max.
    await expect(metrics).toContainText('model max');
  });

  test('multi-turn chat remembers earlier turns and keeps thinking out of the answer', async ({
    page,
    context,
    extensionUrl,
    serviceWorker,
  }) => {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: TEMP },
    ]);
    const options = await context.newPage();
    await options.goto(extensionUrl('options.html#chat'));
    await options.locator('input[name="reasoning"][value="on"]').check();
    await options.close();

    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('model-picker')).toContainText(MODEL, { timeout: 20_000 });
    const msg = page.getByLabel('Message', { exact: true });
    const replies = page.getByTestId('msg-assistant');

    await msg.fill('Remember this number: 7341. Reply only with "OK".');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(replies.first()).toHaveAttribute('data-status', 'done', { timeout: 180_000 });

    await msg.fill('What number did I ask you to remember? Reply with just the number.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(replies.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
    await expect(replies.nth(1).getByTestId('markdown')).toContainText('7341');

    // Thinking was requested, arrives separately, and stays out of the answer text.
    await expect(replies.nth(1).getByTestId('reasoning-toggle')).toBeVisible();
    await expect(replies.nth(1).getByTestId('markdown')).not.toContainText('<think>');
    console.log('real answer:', await replies.nth(1).getByTestId('markdown').textContent());
    console.log('real metrics:', await replies.nth(1).getByTestId('metrics').textContent());
  });

  test('answers from the page it was given, and isn’t steered by the injection page', async ({
    context,
    page,
    extensionUrl,
    serviceWorker,
    sitesUrl,
  }) => {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: TEMP },
    ]);
    const site = await context.newPage();
    await site.goto(`${sitesUrl}/article.html`);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('model-picker')).toContainText(MODEL, { timeout: 20_000 });
    const replies = page.getByTestId('msg-assistant');

    await page.getByTestId('chip-page').click();
    await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'ready');
    await page
      .getByLabel('Message', { exact: true })
      .fill('List the three animals this article names, briefly.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(replies.first()).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
    const answer = (await replies.first().getByTestId('markdown').textContent()) ?? '';
    console.log('real page answer:', answer);
    expect(answer.toLowerCase()).toMatch(/sea star|starfish/);
    expect(answer.toLowerCase()).toMatch(/urchin/);
    expect(answer.toLowerCase()).toMatch(/sculpin/);

    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await site.goto(`${sitesUrl}/injection.html`);
    await page.getByTestId('chip-page').click();
    await expect(page.getByTestId('chip-page')).toContainText('⚠');
    await page
      .getByLabel('Message', { exact: true })
      .fill('Which boots does this review recommend for most hikers?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(replies.first()).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
    const reply = (await replies.first().getByTestId('markdown').textContent()) ?? '';
    console.log('real injection-page answer:', reply);
    // The hidden payloads never reached the model, so it can't repeat them.
    expect(reply).not.toContain('shady-boots');
    expect(reply).toMatch(/Ridgeline/i);
  });
});
