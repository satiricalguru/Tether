import { browser } from 'wxt/browser';
import type { ElementPoint } from '@/agent/page/types';

/**
 * Trusted input via the Chrome DevTools protocol (optional `debugger`
 * permission). Events are `isTrusted`, which some sites, canvas apps and
 * file dialogs require. While attached, Chrome shows its "is being debugged"
 * bar, which the settings page explains before this is enabled.
 */

const VERSION = '1.3';
const attached = new Set<number>();

export async function debuggerAvailable(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

async function send(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (!attached.has(tabId)) {
    await browser.debugger.attach({ tabId }, VERSION);
    attached.add(tabId);
  }
  return browser.debugger.sendCommand({ tabId }, method, params);
}

export async function detachAll(): Promise<void> {
  await Promise.all(
    [...attached].map(async (tabId) => {
      attached.delete(tabId);
      await browser.debugger.detach({ tabId }).catch(() => undefined);
    }),
  );
}

// Undefined until the optional permission is granted.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
browser.debugger?.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

export async function cdpMouse(
  tabId: number,
  p: ElementPoint,
  kind: 'click' | 'rightClick' | 'hover',
): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  if (kind === 'hover') return;
  const button = kind === 'rightClick' ? 'right' : 'left';
  const buttons = kind === 'rightClick' ? 2 : 1;
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: p.x,
    y: p.y,
    button,
    buttons,
    clickCount: 1,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: p.x,
    y: p.y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

export async function cdpInsertText(tabId: number, text: string): Promise<void> {
  await send(tabId, 'Input.insertText', { text });
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** "Ctrl+A", "Shift+Tab", "Enter" → CDP key events. Returns false for keys it doesn't know. */
export async function cdpKey(tabId: number, combo: string): Promise<boolean> {
  const parts = combo.split('+').map((p) => p.trim());
  const name = (parts.pop() ?? '').toLowerCase();
  let modifiers = 0;
  for (const m of parts.map((p) => p.toLowerCase())) {
    if (m === 'alt') modifiers |= 1;
    else if (m === 'ctrl' || m === 'control') modifiers |= 2;
    else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4;
    else if (m === 'shift') modifiers |= 8;
  }
  const k =
    KEYS[name] ??
    (name.length === 1
      ? {
          key: name,
          code: `Key${name.toUpperCase()}`,
          keyCode: name.toUpperCase().charCodeAt(0),
          text: name,
        }
      : undefined);
  if (!k) return false;
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(k.text && !modifiers ? { text: k.text } : {}),
  });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return true;
}
