/// <reference types="chrome" />
import type { Page, Worker } from '@playwright/test';
import type { MockChatBody, MockScriptReply } from '../fixtures/mock-llm/server';
import { expect, test } from './fixtures';
import { configureProviders, withMock } from './helpers';

/*
 * captureVisibleTab needs all-sites access or activeTab, and neither can be
 * granted in a headless test (the permission prompt never resolves). So the
 * capture call itself is covered by the fallback test below, and the
 * compositing is driven directly with a synthetic screenshot.
 */

const call = (name: string, args: Record<string, unknown>): MockScriptReply => ({
  toolCalls: [{ name, arguments: args }],
});

interface ImageMessage {
  role: string;
  content: string;
  images?: string[];
}

interface SomResult {
  image: string;
  width: number;
  height: number;
  thumbnail: string;
  marks: number;
}

/** Width and height from a JPEG's SOF segment. */
function jpegSize(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64, 'base64');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad JPEG marker');
    const marker = buf[i + 1] ?? 0;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF segment');
}

/** Send `offscreen:som` to the offscreen document with a 2560×1440 grey "screenshot" (dpr 2). */
function composite(serviceWorker: Worker): Promise<SomResult> {
  return serviceWorker.evaluate(async () => {
    const canvas = new OffscreenCanvas(2560, 1440);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#ddd';
    ctx.fillRect(0, 0, 2560, 1440);
    const bytes = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer(),
    );
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const screenshot = `data:image/jpeg;base64,${btoa(bin)}`;
    const el = (id: string, x: number, y: number, inViewport = true) => ({
      id,
      tag: 'button',
      role: 'button',
      name: id,
      inViewport,
      rect: { x, y, w: 120, h: 32 },
    });
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: '/offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'test',
      });
    }
    const reply = await chrome.runtime.sendMessage<
      unknown,
      { ok: boolean; value: SomResult; error?: unknown }
    >({
      __tether: 1,
      type: 'offscreen:som',
      payload: {
        screenshot,
        elements: [el('1', 20, 20), el('2', 600, 300), el('3', 0, 0, false)],
        viewportHeight: 720,
        maxSide: 1024,
      },
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.value;
  });
}

async function setVision(serviceWorker: Worker, on: boolean) {
  await serviceWorker.evaluate(async (vision) => {
    const key = 'tether:settings';
    const s = (await chrome.storage.local.get(key))[key] as Record<string, Record<string, unknown>>;
    await chrome.storage.local.set({
      [key]: { ...s, agent: { ...s.agent, vision, critique: false } },
    });
  }, on);
}

async function runTask(page: Page, task: string) {
  await page.getByRole('button', { name: 'Agent mode' }).click();
  await page.getByLabel('Message', { exact: true }).fill(task);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('agent vision tier', () => {
  test('the offscreen document draws the marks, downscales and makes a thumbnail', async ({
    serviceWorker,
  }) => {
    const r = await composite(serviceWorker);
    expect(r).toMatchObject({ width: 1024, height: 576, marks: 2 });
    expect(jpegSize(r.image)).toEqual({ width: 1024, height: 576 });
    expect(r.thumbnail.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(jpegSize(r.thumbnail.slice('data:image/jpeg;base64,'.length))).toEqual({
      width: 320,
      height: 180,
    });
  });

  for (const vision of [true, false]) {
    test(
      vision
        ? 'offers screenshots to a vision model and falls back to text when the tab can’t be captured'
        : 'sends no images and no screenshot tool when screenshots are off',
      async ({ context, page, extensionUrl, serviceWorker, sitesUrl }) => {
        const mock = await withMock({
          flavor: 'ollama',
          models: [{ id: 'vlm:7b', loaded: true, tools: true, vision: true, contextLength: 32768 }],
          script: (_body: MockChatBody) => call('done', { summary: 'Looked at the page.' }),
        });
        try {
          await configureProviders(serviceWorker, [
            { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: mock.url },
          ]);
          await setVision(serviceWorker, vision);
          const site = await context.newPage();
          await site.goto(`${sitesUrl}/shop/index.html`);
          await page.goto(extensionUrl('sidepanel.html'));
          await expect(page.getByTestId('model-picker')).toContainText('vlm:7b');
          await runTask(page, 'What is on this page?');
          const run = page.getByTestId('agent-run');
          await expect(run).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

          const chats = mock.requests
            .filter((r) => r.path === '/api/chat')
            .map(
              (r) =>
                r.body as { messages: ImageMessage[]; tools?: { function: { name: string } }[] },
            );
          expect(chats.length).toBeGreaterThan(0);
          for (const body of chats) {
            expect(body.messages.flatMap((m) => m.images ?? [])).toHaveLength(0);
            const names = (body.tools ?? []).map((t) => t.function.name);
            if (vision) expect(names).toContain('screenshot');
            else expect(names).not.toContain('screenshot');
          }
          if (vision) {
            // No all-sites grant and no activeTab here: the run says why and carries on.
            await expect(page.getByTestId('agent-warning')).toContainText(
              'screenshots need access to all sites',
            );
          } else {
            await expect(page.getByTestId('agent-warning')).toHaveCount(0);
          }
        } finally {
          await mock.close();
        }
      },
    );
  }

  test('the trace viewer shows what the model saw', async ({
    page,
    extensionUrl,
    serviceWorker,
  }) => {
    const { thumbnail } = await composite(serviceWorker);
    await page.goto(extensionUrl('options.html#runs'));
    await page.evaluate(async (thumb) => {
      const open = indexedDB.open('tether');
      const db = await new Promise<IDBDatabase>((res) => {
        open.onsuccess = () => res(open.result);
      });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('traces', 'readwrite');
        tx.objectStore('traces').add({
          id: 'v1',
          runId: 'vision-run',
          step: 1,
          createdAt: Date.now(),
          url: 'https://shop.test/',
          action: 'click',
          args: { id: '2' },
          elementName: 'button "Buy"',
          outcome: 'ok',
          note: 'clicked',
          thumbnail: thumb,
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(new Error('write failed'));
      });
    }, thumbnail);
    await page.reload();
    await page.getByTestId('run').first().getByRole('button').first().click();
    const img = page.getByTestId('run-step-thumbnail');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('alt', 'What the model saw at step 1');
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
  });
});
