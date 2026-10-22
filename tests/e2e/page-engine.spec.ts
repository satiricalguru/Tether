/// <reference types="chrome" />
import type { Page } from '@playwright/test';
import { renderSnapshot } from '@/agent/page/snapshot';
import type {
  ActResult,
  ElementPoint,
  PageAction,
  PageSnapshot,
  SnapshotOptions,
} from '@/agent/page/types';
import { estimateTokens } from '@/context/tokens';
import { expect, test } from './fixtures';

/**
 * The page engine in real Chromium: geometry-based visibility, viewport
 * budgeting, frame offsets and events a real page reacts to. Everything is
 * driven through the content bridge the agent uses.
 */

interface Bridge {
  snapshot: (opts?: SnapshotOptions) => Promise<PageSnapshot>;
  act: (action: PageAction) => Promise<ActResult>;
  stable: () => Promise<{ settledMs: number; reason: 'quiet' | 'cap' }>;
  point: (id: string) => Promise<ElementPoint | null>;
}

function bridge(panel: Page, url: string): Bridge {
  const call = async <T>(type: string, payload: unknown): Promise<T> => {
    const res = await panel.evaluate(
      async ({ url, type, payload }) => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab?.id) throw new Error('fixture tab not found');
        await chrome.runtime.sendMessage({
          __tether: 1,
          type: 'bg:ensure-content-script',
          payload: { tabId: tab.id },
        });
        return chrome.tabs.sendMessage<unknown, { ok: boolean; value?: unknown; error?: unknown }>(
          tab.id,
          { __tether: 1, type, payload },
        );
      },
      { url, type, payload },
    );
    if (!res.ok) throw new Error(`${type} failed: ${JSON.stringify(res.error)}`);
    return res.value as T;
  };
  return {
    snapshot: (opts = {}) => call('content:snapshot', { opts }),
    act: (action) => call('content:act', { action }),
    stable: () => call('content:stable', { quietMs: 200, capMs: 3000 }),
    point: (id) => call('content:point', { id }),
  };
}

function byName(s: PageSnapshot, name: string) {
  const e = s.elements.find((x) => x.name === name);
  if (!e) throw new Error(`no "${name}" in:\n${renderSnapshot(s)}`);
  return e;
}

const sizes: Record<string, number> = {};

test.afterAll(() => {
  // Measured snapshot sizes, for the report.
  console.log('snapshot tokens:', JSON.stringify(sizes));
});

test('controlled form: React-style input, hidden checkbox, select, submit with real events', async ({
  context,
  page,
  extensionUrl,
  sitesUrl,
}) => {
  const url = `${sitesUrl}/engine/form.html`;
  const site = await context.newPage();
  await site.goto(url);
  await page.goto(extensionUrl('sidepanel.html'));
  const b = bridge(page, url);

  const s = await b.snapshot();
  sizes.form = estimateTokens(renderSnapshot(s));
  const name = byName(s, 'Full name');
  const gift = byName(s, 'Gift wrap');
  const pw = byName(s, 'Password');
  expect(gift.role).toBe('checkbox');
  expect(pw.type).toBe('password');
  expect(byName(s, 'Place order').submits).toBe(true);

  expect(await b.act({ kind: 'type', id: name.id, text: 'Ada Lovelace' })).toMatchObject({
    ok: true,
  });
  await expect(site.locator('#state')).toHaveText('state: name="Ada Lovelace"');

  expect(await b.act({ kind: 'select', id: byName(s, 'Size').id, option: 'Medium' })).toMatchObject(
    { ok: true },
  );
  // The real checkbox is a 1px transparent input; the label is clicked instead.
  expect(await b.act({ kind: 'check', id: gift.id, state: true })).toMatchObject({ ok: true });
  await expect(site.locator('#gift')).toBeChecked();

  // Never types into a password field.
  expect(await b.act({ kind: 'type', id: pw.id, text: 'hunter2' })).toMatchObject({ ok: false });
  await expect(site.locator('#pw')).toHaveValue('');

  expect(await b.act({ kind: 'click', id: byName(s, 'Place order').id })).toMatchObject({
    ok: true,
  });
  await expect(site.locator('#result')).toHaveText(
    'Submitted: name=Ada Lovelace; size=m; gift=yes',
  );
  // Events carry the button's real on-screen centre.
  const box = (await site.locator('button').boundingBox())!;
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  await expect(site.locator('#events')).toHaveText(
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
      .map((t) => `${t}@${cx},${cy}`)
      .join(' '),
  );

  // A changed page hashes differently from the first snapshot.
  expect((await b.snapshot()).hash).not.toBe(s.hash);
  expect((await b.stable()).reason).toBe('quiet');
});

test('geometry: hidden techniques, viewport budget, modal priority', async ({
  context,
  page,
  extensionUrl,
  sitesUrl,
}) => {
  const url = `${sitesUrl}/engine/geometry.html`;
  const site = await context.newPage();
  await site.setViewportSize({ width: 1000, height: 700 });
  await site.goto(url);
  await page.goto(extensionUrl('sidepanel.html'));
  const b = bridge(page, url);

  const s = await b.snapshot();
  sizes.geometry = estimateTokens(renderSnapshot(s));
  const names = s.elements.map((e) => e.name);
  expect(names).toContain('Visible action');
  expect(names).toContain('Visible inside hidden');
  for (const hidden of [
    'display none',
    'visibility',
    'opacity',
    'offscreen',
    'zero size',
    'aria',
  ]) {
    expect(names).not.toContain(`Hidden ${hidden}`);
  }
  // 800 list controls: only those near the viewport are listed.
  expect(names).toContain('Item 1');
  expect(names).not.toContain('Item 400');
  expect(s.scroll.height).toBeGreaterThan(s.scroll.viewport * 3);
  expect(sizes.geometry).toBeLessThanOrEqual(4200);

  // Scrolling to the bottom brings the tail of the list into the snapshot.
  expect(await b.act({ kind: 'scroll', direction: 'down', amount: 100_000 })).toMatchObject({
    ok: true,
  });
  const bottom = await b.snapshot();
  expect(bottom.elements.map((e) => e.name)).toContain('Add item 400');
  expect(bottom.elements.find((e) => e.name === 'Add item 400')?.inViewport).toBe(true);

  // A tight budget drops low-priority elements but keeps their ids resolvable.
  const tight = await b.snapshot({ maxTokens: 300, task: 'add item 395 to the cart' });
  sizes.geometryTight = estimateTokens(renderSnapshot(tight));
  expect(tight.dropped).toBeGreaterThan(0);
  expect(tight.elements.map((e) => e.name)).toContain('Add item 395');

  // Modal: its controls lead and the snapshot says a dialog is open.
  await b.act({ kind: 'scroll', direction: 'up', amount: 100_000 });
  const top = await b.snapshot();
  await b.act({ kind: 'click', id: byName(top, 'Open settings').id });
  const modal = await b.snapshot();
  sizes.geometryModal = estimateTokens(renderSnapshot(modal));
  expect(modal.dialog).toBe('Settings');
  expect(renderSnapshot(modal)).toContain('DIALOG OPEN: "Settings"');
  // Everything outside a modal is inert: only the dialog's controls are listed.
  expect(modal.elements.map((e) => e.name)).toEqual(['Nickname', 'Close settings']);
  // ...but ids from before it opened still resolve.
  expect(await b.act({ kind: 'hover', id: byName(top, 'Open settings').id })).toMatchObject({
    ok: true,
  });
  expect(await b.act({ kind: 'pressKey', key: 'Escape' })).toMatchObject({ ok: true });
  await expect(site.locator('#modal')).not.toHaveAttribute('open');
});

test('frames and shadow DOM: prefixed ids, offsets, opaque frames', async ({
  context,
  page,
  extensionUrl,
  sitesUrl,
}) => {
  const url = `${sitesUrl}/engine/frames.html`;
  const site = await context.newPage();
  await site.goto(url);
  await site.frameLocator('#inner').locator('#sub').waitFor();
  await page.goto(extensionUrl('sidepanel.html'));
  const b = bridge(page, url);

  const s = await b.snapshot();
  sizes.frames = estimateTokens(renderSnapshot(s));

  // Open shadow root controls are listed and work.
  const shadowInput = byName(s, 'Shadow search');
  await b.act({ kind: 'type', id: shadowInput.id, text: 'lamps' });
  await b.act({ kind: 'click', id: byName(s, 'Shadow go').id });
  await expect(site.locator('#log')).toHaveText('shadow:lamps');

  // Same-origin frame: ids are frame-prefixed and rects are in top-page coordinates.
  const email = byName(s, 'Email');
  const sub = byName(s, 'Subscribe');
  expect(email.id).toMatch(/^1\.\d+$/);
  expect(sub.id).toMatch(/^1\.\d+$/);
  const frameBox = (await site.locator('#inner').boundingBox())!;
  const subBox = (await site.frameLocator('#inner').locator('#sub').boundingBox())!;
  expect(Math.abs(sub.rect.x - subBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(sub.rect.y - subBox.y)).toBeLessThanOrEqual(2);
  expect(sub.rect.x).toBeGreaterThan(frameBox.x);

  const pt = await b.point(sub.id);
  expect(pt).not.toBeNull();
  expect(Math.abs(pt!.x - (subBox.x + subBox.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(pt!.y - (subBox.y + subBox.height / 2))).toBeLessThanOrEqual(2);

  await b.act({ kind: 'type', id: email.id, text: 'ada@example.com' });
  await b.act({ kind: 'click', id: sub.id });
  // Event coordinates are frame-local, as a real click's would be.
  const local = await site
    .frameLocator('#inner')
    .locator('#sub')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
    });
  await expect(site.frameLocator('#inner').locator('#done')).toHaveText(
    `Subscribed ada@example.com at ${local}`,
  );

  // Cross-origin and sandboxed frames are listed as unreadable.
  const opaque = s.frames.filter((f) => f.opaque);
  expect(opaque.map((f) => f.name).sort()).toEqual(['Ads', 'Sandbox']);
  expect(s.elements.map((e) => e.name)).not.toContain('Sandboxed');
  expect(renderSnapshot(s)).toContain('FRAMES:');
});
