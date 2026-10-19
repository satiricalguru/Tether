/// <reference types="chrome" />
import { expect, test } from './fixtures';

interface ManifestLike {
  host_permissions?: string[];
  optional_host_permissions?: string[];
  permissions?: string[];
}

test.describe('extension load', () => {
  test('service worker registers with the expected permission set', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(
      () => chrome.runtime.getManifest() as ManifestLike,
    );
    expect(manifest.host_permissions).toEqual([
      'http://localhost/*',
      'http://127.0.0.1/*',
      'http://[::1]/*',
    ]);
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['storage', 'sidePanel', 'scripting', 'offscreen', 'alarms']),
    );
  });

  test('toolbar action is configured to open the side panel', async ({ serviceWorker }) => {
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () => {
          const b = await chrome.sidePanel.getPanelBehavior();
          return b.openPanelOnActionClick;
        }),
      )
      .toBe(true);
  });
});

test.describe('side panel', () => {
  test('renders and reaches the background worker', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByRole('heading', { name: 'Tether' })).toBeVisible();
    const status = page.getByTestId('bg-status');
    await expect(status).toHaveAttribute('data-state', 'connected');
    await expect(status).toContainText('v0.1.0');
  });

  test('streams tokens through a port and keeps the worker alive meanwhile', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    const text = Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ');
    await page.getByLabel('Transport check input').fill(text);
    await page.getByRole('button', { name: 'Run' }).click();

    await expect(page.getByTestId('echo-state')).toHaveText('streaming');
    await expect
      .poll(() => serviceWorker.evaluate(() => chrome.alarms.get('tether:keepalive')))
      .toBeTruthy();

    await expect(page.getByTestId('echo-state')).toHaveText('done', { timeout: 10_000 });
    await expect(page.getByTestId('echo-output')).toHaveText(text);
    await expect
      .poll(() => serviceWorker.evaluate(() => chrome.alarms.get('tether:keepalive')))
      .toBeFalsy();
  });

  test('stop aborts the stream mid-flight', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    await page.getByLabel('Transport check input').fill(text);
    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByTestId('echo-output')).toContainText('w3');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('echo-state')).toHaveText('aborted');

    const partial = await page.getByTestId('echo-output').textContent();
    await page.waitForTimeout(400);
    // Nothing more arrives after abort.
    await expect(page.getByTestId('echo-output')).toHaveText(partial ?? '');
    expect(partial?.length).toBeLessThan(text.length);
  });
});

test.describe('options', () => {
  test('renders and persists the theme across reloads', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('options.html'));
    await expect(page.getByRole('heading', { name: 'Tether settings' })).toBeVisible();
    await page.getByLabel('Dark').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.getByLabel('Dark')).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('theme changes propagate live to an open side panel', async ({
    context,
    page,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    const options = await context.newPage();
    await options.goto(extensionUrl('options.html'));
    await options.getByLabel('Light').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('content bridge', () => {
  test('injects on demand into a permitted page and answers pings', async ({
    context,
    page,
    extensionUrl,
    sitesUrl,
  }) => {
    const site = await context.newPage();
    await site.goto(`${sitesUrl}/basic.html`);
    await page.goto(extensionUrl('sidepanel.html'));

    const result = await page.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      if (!tab?.id) throw new Error('fixture tab not found');
      const send = (type: string, payload: unknown): Promise<unknown> =>
        chrome.runtime.sendMessage({ __tether: 1, type, payload });
      const first = await send('bg:ensure-content-script', { tabId: tab.id });
      const second = await send('bg:ensure-content-script', { tabId: tab.id });
      const ping: unknown = await chrome.tabs.sendMessage(tab.id, {
        __tether: 1,
        type: 'content:ping',
      });
      return { first, second, ping };
    }, `${sitesUrl}/basic.html`);

    expect(result.first).toEqual({ ok: true, value: { injected: true } });
    // Second call finds the bridge already alive and doesn't re-inject.
    expect(result.second).toEqual({ ok: true, value: { injected: false } });
    expect(result.ping).toEqual({
      ok: true,
      value: { url: `${sitesUrl}/basic.html`, title: 'Tether fixture: basic' },
    });
  });
});

test.describe('offscreen document', () => {
  test('is creatable and answers its own namespace', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    await serviceWorker.evaluate(async () => {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_PARSER'],
          justification: 'e2e check',
        });
      }
    });
    await page.goto(extensionUrl('sidepanel.html'));
    // createDocument resolves before the page's module script has run.
    await expect
      .poll(() =>
        page.evaluate((): Promise<unknown> =>
          chrome.runtime.sendMessage({ __tether: 1, type: 'offscreen:ping' }),
        ),
      )
      .toMatchObject({ ok: true, value: { pong: true, version: '0.1.0' } });
  });
});
