/// <reference types="chrome" />
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

test.describe('setup doctor', () => {
  test('lists every backend as not running when nothing answers, and the transport works', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:1' },
    ]);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('doctor-summary')).toHaveText('No local model server found');
    await page.getByText(/Not running: Ollama/).click();
    await expect(page.getByTestId('doctor-ollama')).toHaveAttribute(
      'data-diagnosis',
      'unreachable',
    );
    await expect(page.getByTestId('doctor-ollama')).toContainText('ollama serve');
    await expect(page.getByTestId('transport-check')).toContainText('streaming OK');
  });

  test('diagnoses the real Ollama origin check with this extension’s ID', async ({
    page,
    extensionUrl,
    extensionId,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'ollama', rejectOrigins: true, allowedOrigins: [] });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      const row = page.getByTestId('doctor-ollama');
      await expect(row).toHaveAttribute('data-diagnosis', 'origin-blocked');
      await expect(row).toContainText(
        `launchctl setenv OLLAMA_ORIGINS "chrome-extension://${extensionId}"`,
      );
      await row.getByRole('tab', { name: 'Linux' }).click();
      await expect(row).toContainText('systemctl edit ollama.service');
      // Chrome really sent the extension origin.
      expect(
        mock.requests.some((r) => r.headers.origin === `chrome-extension://${extensionId}`),
      ).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

test.describe('quick prompt', () => {
  test('auto-selects the hot model, streams a reply with metrics, keeps the worker alive', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({
      flavor: 'ollama',
      rejectOrigins: true,
      allowedOrigins: ['chrome-extension://*'],
      tokenDelayMs: 40,
    });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
      await page.getByLabel('Prompt').fill('Say hello');
      await page.getByRole('button', { name: 'Send' }).click();

      await expect(page.getByTestId('run-output')).toHaveAttribute('data-phase', 'running');
      await expect
        .poll(() => serviceWorker.evaluate(() => chrome.alarms.get('tether:keepalive')))
        .toBeTruthy();
      await expect(page.getByTestId('run-output')).toHaveAttribute('data-phase', 'done');
      await expect(page.getByTestId('run-text')).toHaveText('Hello from the mock model.');
      const metrics = page.getByTestId('metrics');
      await expect(metrics).toContainText('TTFT');
      await expect(metrics).toContainText('tok/s');
      await expect(metrics).toContainText('context');
      await expect
        .poll(() => serviceWorker.evaluate(() => chrome.alarms.get('tether:keepalive')))
        .toBeFalsy();
    } finally {
      await mock.close();
    }
  });

  test('stop aborts generation at the server', async ({ page, extensionUrl, serviceWorker }) => {
    const reply = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const mock = await withMock({ flavor: 'openai', reply, tokenDelayMs: 30 });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'box', kind: 'openai-compatible', label: 'Box', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText('Qwen/Qwen2.5-7B-Instruct');
      await page.getByLabel('Prompt').fill('go');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('run-text')).toContainText('w3');
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByTestId('run-output')).toHaveAttribute('data-phase', 'stopped');
      const partial = (await page.getByTestId('run-text').textContent()) ?? '';
      await page.waitForTimeout(300);
      await expect(page.getByTestId('run-text')).toHaveText(partial);
      expect(partial.length).toBeLessThan(reply.length);
      // Regression: Stop must not resubmit the prompt.
      expect(mock.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  test('shows a loading-model state for a cold model instead of looking hung', async ({
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
      await page.getByLabel('Prompt').fill('wake up');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'loading-model');
      await expect(page.getByTestId('run-status')).toContainText('Loading model into memory');
      await expect(page.getByTestId('run-output')).toHaveAttribute('data-phase', 'done', {
        timeout: 10_000,
      });
      await expect(page.getByTestId('metrics')).toContainText('load');
    } finally {
      await mock.close();
    }
  });
});

test.describe('provider settings', () => {
  test('lists models with capabilities and runs a per-model test', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'lmstudio' });
    try {
      await configureProviders(serviceWorker, [
        { instanceId: 'lmstudio', kind: 'lmstudio', label: 'LM Studio', baseUrl: mock.url },
      ]);
      await page.goto(extensionUrl('options.html'));
      await expect(page.getByTestId('doctor-lmstudio')).toHaveAttribute('data-diagnosis', 'ok');
      await page.getByRole('button', { name: 'Show models for LM Studio' }).click();
      const list = page.getByTestId('models-lmstudio');
      await expect(list).toContainText('qwen2.5-7b-instruct');
      await expect(list).toContainText('tools');
      await expect(list).toContainText('vision');
      await list.getByRole('listitem').first().getByRole('button', { name: 'Test' }).click();
      await expect(list.getByTestId('run-text')).toHaveText('Hello from the mock model.');
    } finally {
      await mock.close();
    }
  });

  test('adds a custom keyed endpoint and reports it connected', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const mock = await withMock({ flavor: 'openai', apiKey: 'sk-e2e-key' });
    try {
      await configureProviders(serviceWorker, []);
      await page.goto(extensionUrl('options.html'));
      await page.getByRole('button', { name: 'Add endpoint' }).click();
      const form = page.getByTestId('provider-form-new');
      await form.getByLabel('Name').fill('Test vLLM');
      await form.getByLabel('Base URL').fill(mock.url);
      await form.getByLabel('API key (optional)').fill('sk-e2e-key');
      await form.getByRole('button', { name: 'Add endpoint' }).click();

      const card = page.getByTestId(/^provider-custom-/);
      await expect(card).toContainText('Test vLLM');
      await expect(card).toContainText('key');
      await expect(page.getByTestId(/^doctor-custom-/)).toHaveAttribute('data-diagnosis', 'ok');
      expect(mock.requests.some((r) => r.headers.authorization === 'Bearer sk-e2e-key')).toBe(true);

      // The key is stored locally but never sent back to the UI.
      const status: unknown = await page.evaluate(() =>
        chrome.runtime.sendMessage({ __tether: 1, type: 'bg:providers:status' }),
      );
      expect(JSON.stringify(status)).not.toContain('sk-e2e-key');
    } finally {
      await mock.close();
    }
  });
});
