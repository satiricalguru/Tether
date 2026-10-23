/// <reference types="chrome" />
import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';

const DARK_BG = 'rgb(33, 33, 33)';
const LIGHT_BG = 'rgb(255, 255, 255)';

async function setTheme(serviceWorker: Worker, theme: 'system' | 'light' | 'dark') {
  await serviceWorker.evaluate(async (t) => {
    const key = 'tether:settings';
    const s = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
    await chrome.storage.local.set({ [key]: { ...s, theme: t } });
  }, theme);
}

test.describe('dark mode', () => {
  test('the panel follows the OS under "system", and the setting overrides it', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByRole('img', { name: 'Tether' })).toBeVisible();
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect.poll(bg).toBe(DARK_BG);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(bg).toBe(LIGHT_BG);

    // Chosen in settings: wins over the OS, live.
    await setTheme(serviceWorker, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(bg).toBe(DARK_BG);
    // The primary button inverts: near-white on dark.
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await page.getByLabel('Message', { exact: true }).fill('hi');
    await expect
      .poll(() => send.evaluate((b) => getComputedStyle(b).backgroundColor))
      .toBe('rgb(236, 236, 236)');
  });

  test('the bubble and compose popover follow the theme setting on pages', async ({
    context,
    serviceWorker,
    sitesUrl,
  }) => {
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () =>
          (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
        ),
      )
      .toEqual(['tether-bridge']);
    const site = await context.newPage();
    await site.goto(`${sitesUrl}/compose.html`);
    const bubble = site.locator('tether-bubble');
    await expect(bubble).toHaveCount(1);
    // "System": no attribute, so the OS decides.
    await expect(bubble).not.toHaveAttribute('data-theme');

    await setTheme(serviceWorker, 'dark');
    await expect(bubble).toHaveAttribute('data-theme', 'dark');

    await site.locator('#note').click();
    await site.keyboard.press('ControlOrMeta+k');
    const compose = site.locator('tether-compose');
    await expect(compose).toHaveAttribute('data-state', 'open');
    await expect(compose).toHaveAttribute('data-theme', 'dark');

    await setTheme(serviceWorker, 'light');
    await expect(bubble).toHaveAttribute('data-theme', 'light');
    await expect(compose).toHaveAttribute('data-theme', 'light');
  });
});
