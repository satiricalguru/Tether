/// <reference types="chrome" />
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import type { MockChatBody, MockScriptReply } from '../fixtures/mock-llm/server';
import { expect, test } from '../e2e/fixtures';
import { configureProviders, withMock } from '../e2e/helpers';
import { tetherUi } from '../e2e/shadow';

/**
 * `pnpm docs:media` — README screenshots and the demo GIF, taken against
 * the mock model server so they're reproducible. Output: docs/images/.
 */

const OUT = resolve(import.meta.dirname, '../../docs/images');
const PANEL = { width: 420, height: 720 };
const SITE = { width: 960, height: 720 };
mkdirSync(OUT, { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(OUT, `${name}.png`) });

async function useModel(serviceWorker: Worker, url: string, model = 'llama3.2:3b') {
  await configureProviders(serviceWorker, [
    { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: url },
  ]);
  await serviceWorker.evaluate(async (m) => {
    const key = 'tether:settings';
    const s = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
    await chrome.storage.local.set({
      [key]: { ...s, selection: { instanceId: 'ollama', model: m } },
    });
  }, model);
}

const ANSWER = `The article mentions these tidepool animals:

- **Ochre sea stars**, which pry mussels open with steady pressure
- **Giant green anemones**, which get their colour from algae
- **Hermit crabs**, which trade shells as they grow

The best viewing is at low tide, around **05:12** on the morning listed.`;

test.describe.configure({ mode: 'serial' });

test('chat with page context', async ({ context, page, extensionUrl, serviceWorker, sitesUrl }) => {
  const mock = await withMock({ flavor: 'ollama', reply: ANSWER });
  try {
    await useModel(serviceWorker, mock.url);
    const site = await context.newPage();
    await site.goto(`${sitesUrl}/article.html`);
    await page.setViewportSize(PANEL);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
    await page.getByTestId('chip-page').click();
    await expect(page.getByTestId('chip-page')).toHaveAttribute('data-status', 'ready');
    await page.getByLabel('Message', { exact: true }).fill('Which animals are mentioned?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('msg-assistant')).toHaveAttribute('data-status', 'done');
    await shot(page, 'chat-page-context');
  } finally {
    await mock.close();
  }
});

test('highlight bubble', async ({ context, serviceWorker, sitesUrl }) => {
  const mock = await withMock({
    flavor: 'ollama',
    reply:
      'A **tidepool** is a pocket of seawater left among the rocks when the tide goes out. The animals in it must survive heat, waves and changing saltiness until the sea returns.',
  });
  try {
    await useModel(serviceWorker, mock.url);
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () =>
          (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
        ),
      )
      .toEqual(['tether-bridge']);
    const site = await context.newPage();
    await site.setViewportSize(SITE);
    await site.goto(`${sitesUrl}/article.html`);
    const bubble = await tetherUi(site, 'TETHER-BUBBLE');
    await site.locator('h1').dblclick();
    await expect.poll(() => bubble.buttons()).toContain('Explain');
    await bubble.click('Explain');
    await expect
      .poll(() => bubble.buttons(), { timeout: 10_000 })
      .toContain('Continue in side panel');
    await shot(site, 'highlight-bubble');
  } finally {
    await mock.close();
  }
});

test('inline compose', async ({ context, serviceWorker, sitesUrl }) => {
  const mock = await withMock({
    flavor: 'ollama',
    reply: 'Hi Sam, could you send me the quarterly report by Friday? Thanks so much!',
  });
  try {
    await useModel(serviceWorker, mock.url);
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () =>
          (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
        ),
      )
      .toEqual(['tether-bridge']);
    const site = await context.newPage();
    await site.setViewportSize(SITE);
    await site.goto(`${sitesUrl}/compose.html`);
    const ui = await tetherUi(site, 'TETHER-COMPOSE');
    await site.locator('#note').click();
    await site.keyboard.press('ControlOrMeta+k');
    await expect.poll(() => ui.buttons()).toContain('Rewrite');
    await ui.click('Rewrite');
    await expect
      .poll(() => site.locator('tether-compose').getAttribute('data-state'), { timeout: 10_000 })
      .toBe('ready');
    await shot(site, 'inline-compose');
  } finally {
    await mock.close();
  }
});

test('setup doctor', async ({ page, extensionUrl, serviceWorker }) => {
  const mock = await withMock({ flavor: 'ollama', rejectOrigins: true, allowedOrigins: [] });
  try {
    await configureProviders(serviceWorker, [
      { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
    ]);
    await page.setViewportSize(PANEL);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('doctor-ollama')).toHaveAttribute(
      'data-diagnosis',
      'origin-blocked',
    );
    await shot(page, 'setup-doctor');
  } finally {
    await mock.close();
  }
});

// ---------- the agent demo (screenshots + GIF) ----------

function lastObservation(body: MockChatBody): string {
  const last = body.messages?.at(-1)?.content;
  return typeof last === 'string' ? last : '';
}
function idOf(body: MockChatBody, role: string, name: string): string | undefined {
  const escaped = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\[([\\d.]+)\\] <${role}[^>]*> ${escaped}`, 'm').exec(
    lastObservation(body),
  )?.[1];
}
const call = (name: string, args: Record<string, unknown>): MockScriptReply => ({
  toolCalls: [{ name, arguments: args }],
});

test('agent run with a confirmation, and its trace', async ({
  context,
  page,
  extensionUrl,
  serviceWorker,
  sitesUrl,
}) => {
  const frames = resolve(OUT, '.frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  let n = 0;
  const frame = async (site: Page, hold = 1) => {
    for (let i = 0; i < hold; i++) {
      const k = String(n++).padStart(3, '0');
      await site.screenshot({ path: resolve(frames, `site-${k}.png`) });
      await page.screenshot({ path: resolve(frames, `panel-${k}.png`) });
    }
  };

  const mock = await withMock({
    flavor: 'ollama',
    models: [{ id: 'llama3.2:3b', loaded: true, tools: true }],
    script: (body) => {
      const obs = lastObservation(body);
      if ((/^URL: (\S+)/m.exec(obs)?.[1] ?? '').includes('results.html')) {
        return call('done', {
          summary:
            'The cheapest in-stock audio result for “headphones” is the **Nimbus Over-Ear Headphones** at **$119**.',
        });
      }
      const q = idOf(body, '(?:textbox|searchbox)', 'Search');
      if (q && !obs.includes('value="headphones"'))
        return call('type', { id: q, text: 'headphones' });
      const cat = idOf(body, 'combobox', 'Category');
      if (cat && !obs.includes('value="Audio"'))
        return call('select', { id: cat, option: 'Audio' });
      const stock = idOf(body, 'checkbox', 'In stock only');
      if (stock && !new RegExp(`^\\[${stock}\\][^\\n]* checked`, 'm').test(obs))
        return call('check', { id: stock, state: true });
      const go = idOf(body, 'button', 'Search');
      return go ? call('click', { id: go }) : undefined;
    },
  });
  try {
    await useModel(serviceWorker, mock.url);
    await serviceWorker.evaluate(async () => {
      const key = 'tether:settings';
      const s = (await chrome.storage.local.get(key))[key] as Record<
        string,
        Record<string, unknown>
      >;
      await chrome.storage.local.set({ [key]: { ...s, agent: { ...s.agent, critique: false } } });
    });
    const site = await context.newPage();
    await site.setViewportSize(SITE);
    await site.goto(`${sitesUrl}/apps/search/index.html`);
    await page.setViewportSize(PANEL);
    await page.goto(extensionUrl('sidepanel.html'));
    await expect(page.getByTestId('model-picker')).toContainText('llama3.2:3b');
    await page.getByRole('button', { name: 'Agent mode' }).click();
    await page
      .getByLabel('Message', { exact: true })
      .fill('Find the cheapest in-stock headphones in the Audio category, with its price.');
    await frame(site, 2);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const confirm = page.getByTestId('agent-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await frame(site, 3);
    await shot(page, 'agent-confirm');
    await confirm.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByTestId('agent-run')).toHaveAttribute('data-status', 'done', {
      timeout: 20_000,
    });
    await expect(site).toHaveURL(/results\.html\?.*q=headphones.*cat=audio.*stock=1/);
    await frame(site, 4);
    await shot(page, 'agent-done');

    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(extensionUrl('options.html#runs'));
    await page.getByTestId('run').first().getByRole('button').first().click();
    await expect(page.getByTestId('run-step').first()).toBeVisible();
    await page.getByTestId('runs').screenshot({ path: resolve(OUT, 'trace-viewer.png') });

    // Side by side (page | panel), one frame a second, palette-optimised.
    try {
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-framerate',
          '1',
          '-i',
          resolve(frames, 'site-%03d.png'),
          '-framerate',
          '1',
          '-i',
          resolve(frames, 'panel-%03d.png'),
          '-filter_complex',
          '[0][1]hstack=inputs=2,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
          resolve(OUT, 'demo.gif'),
        ],
        { stdio: 'inherit' },
      );
    } catch (err) {
      test.info().annotations.push({ type: 'warning', description: `no GIF: ${String(err)}` });
    }
    rmSync(frames, { recursive: true, force: true });
  } finally {
    await mock.close();
  }
});
