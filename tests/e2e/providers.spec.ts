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
