import { browser } from 'wxt/browser';
import { platform } from './capabilities';

/** Firefox's sidebar API isn't in @types/chrome; this is the subset we use. */
interface SidebarAction {
  open(): Promise<void>;
  toggle(): Promise<void>;
}

const sidebarAction = () => (browser as unknown as { sidebarAction: SidebarAction }).sidebarAction;

/**
 * Make the toolbar button (and the `_execute_action` shortcut) open the panel.
 * Firefox wires the shortcut as `_execute_sidebar_action` in the manifest; its
 * toolbar button has no popup, so a click fires `action.onClicked`, and the
 * sidebar is toggled right there, inside the user gesture. Call on every
 * background start: the listener is registered synchronously.
 */
export async function configurePanelBehavior(): Promise<void> {
  if (platform.sidePanel) {
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return;
  }
  if (platform.sidebarAction) {
    browser.action.onClicked.addListener(() => {
      void sidebarAction().toggle();
    });
  }
}

/**
 * Open the panel programmatically. Must run inside a user gesture (context
 * menu click, command, action click) on every browser.
 */
export async function openPanel(windowId: number): Promise<void> {
  if (platform.sidePanel) {
    await browser.sidePanel.open({ windowId });
    return;
  }
  if (platform.sidebarAction) {
    // Called before any await, so Firefox still sees the user gesture.
    await sidebarAction().open();
    return;
  }
  // No panel API at all: fall back to the panel page in a tab.
  await browser.tabs.create({ url: browser.runtime.getURL('/sidepanel.html'), windowId });
}
