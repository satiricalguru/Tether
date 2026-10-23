import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { debuggerAvailable } from '@/background/debugger';
import { platform } from '@/platform/capabilities';
import { callOffscreen } from '@/platform/offscreen';
import { configurePanelBehavior, openPanel } from '@/platform/sidePanel';

/**
 * The same code runs on Chromium and Firefox; these shims are where the two
 * differ. Each test installs one browser's APIs on the fake and checks the
 * other browser's are never touched.
 */

const added: string[] = [];
function install(apis: Record<string, unknown>) {
  for (const [k, v] of Object.entries(apis)) {
    (fakeBrowser as unknown as Record<string, unknown>)[k] = v;
    added.push(k);
  }
}
function manifest(m: Record<string, unknown>) {
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue(m as never);
}

afterEach(() => {
  for (const k of added.splice(0)) Reflect.deleteProperty(fakeBrowser, k);
});

const WHY = { reasons: ['BLOBS' as const], justification: 'test' };

describe('Chromium', () => {
  it('opens the side panel from the toolbar button and on request', async () => {
    const sidePanel = {
      open: vi.fn(() => Promise.resolve()),
      setPanelBehavior: vi.fn(() => Promise.resolve()),
    };
    install({ sidePanel });
    await configurePanelBehavior();
    expect(sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    await openPanel(7);
    expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it('runs offscreen work in the offscreen document', async () => {
    const offscreen = { createDocument: vi.fn(() => Promise.resolve()) };
    install({ offscreen });
    Object.assign(fakeBrowser.runtime, { getContexts: vi.fn(() => Promise.resolve([])) });
    const send = vi
      .spyOn(fakeBrowser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: true, value: { pong: true, version: 'x', at: 1 } } as never);
    await expect(callOffscreen('offscreen:ping', undefined, WHY)).resolves.toMatchObject({
      pong: true,
    });
    expect(offscreen.createDocument).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'offscreen:ping' }));
  });

  it('can offer trusted input before the debugger permission is granted', async () => {
    manifest({ optional_permissions: ['debugger', 'downloads'] });
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
    expect(platform.debuggerPermission).toBe(true);
    await expect(debuggerAvailable()).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({ permissions: ['debugger'] });
  });
});

describe('Firefox', () => {
  it('toggles the sidebar from the toolbar button, inside the click', async () => {
    const sidebarAction = {
      open: vi.fn(() => Promise.resolve()),
      toggle: vi.fn(() => Promise.resolve()),
    };
    install({ sidebarAction });
    await configurePanelBehavior();
    expect(sidebarAction.toggle).not.toHaveBeenCalled();
    await fakeBrowser.action.onClicked.trigger({} as never);
    expect(sidebarAction.toggle).toHaveBeenCalledOnce();
  });

  it('opens the sidebar synchronously, so the user gesture survives', () => {
    const sidebarAction = { open: vi.fn(() => Promise.resolve()), toggle: vi.fn() };
    install({ sidebarAction });
    void openPanel(3);
    // No await between the call and sidebarAction.open().
    expect(sidebarAction.open).toHaveBeenCalledOnce();
  });

  it('runs offscreen work in place, in the background page', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    const r = await callOffscreen('offscreen:ping', undefined, WHY);
    expect(r).toMatchObject({ pong: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('hides trusted input and never asks about the debugger permission', async () => {
    manifest({ optional_permissions: ['downloads'] });
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains');
    expect(platform.debuggerPermission).toBe(false);
    await expect(debuggerAvailable()).resolves.toBe(false);
    expect(contains).not.toHaveBeenCalled();
  });
});

describe('no panel API at all', () => {
  it('opens the panel page in a tab', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await openPanel(5);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/sidepanel.html') as string,
        windowId: 5,
      }),
    );
  });
});
