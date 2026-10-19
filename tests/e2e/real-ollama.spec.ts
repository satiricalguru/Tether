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
      .toMatch(/^(origin-blocked|ok)$/);
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

    await page.getByLabel('Prompt').fill('Reply with exactly: Tether works');
    await page.getByRole('button', { name: 'Send' }).click();
    // Cold load first: the watchdog must say so rather than look hung.
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'loading-model', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('run-output')).toHaveAttribute('data-phase', 'done', {
      timeout: 180_000,
    });
    await expect(page.getByTestId('run-text')).toContainText('Tether works');
    const metrics = page.getByTestId('metrics');
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
});
