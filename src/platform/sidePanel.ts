import { browser } from 'wxt/browser';
import { platform } from './capabilities';

/** Firefox's sidebar API isn't in @types/chrome; this is the subset we use. */
interface SidebarAction {
  open(): Promise<void>;
}

/**
 * Make the toolbar button (and the `_execute_action` shortcut) open the panel.
 * Firefox wires `_execute_sidebar_action` in the manifest instead, so there is
 * nothing to do there.
 */
export async function configurePanelBehavior(): Promise<void> {
  if (!platform.sidePanel) return;
  await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
    const sidebar = (browser as unknown as { sidebarAction: SidebarAction }).sidebarAction;
    await sidebar.open();
    return;
  }
  // No panel API at all: fall back to the panel page in a tab.
  await browser.tabs.create({ url: browser.runtime.getURL('/sidepanel.html'), windowId });
}
