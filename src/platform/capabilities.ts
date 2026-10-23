import { browser } from 'wxt/browser';

/**
 * Runtime feature detection for browser-specific APIs. Every Chromium-only
 * API is reached through `src/platform/*`, which checks these first so the
 * Firefox build degrades instead of throwing.
 */

function has(path: string): boolean {
  let node: unknown = browser;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return node !== undefined;
}

export const platform = {
  get sidePanel(): boolean {
    return has('sidePanel.open');
  },
  get sidebarAction(): boolean {
    return has('sidebarAction.open');
  },
  get offscreen(): boolean {
    return has('offscreen.createDocument');
  },
  /**
   * Whether this build can ask for the `debugger` permission at all (Chromium
   * lists it as optional; Firefox has no such API). Unlike `debuggerApi`,
   * this is true before the grant.
   */
  get debuggerPermission(): boolean {
    try {
      return (browser.runtime.getManifest().optional_permissions ?? []).includes('debugger');
    } catch {
      return false;
    }
  },
  /** `debugger` is an optional permission, so the API may appear only after a grant. */
  get debuggerApi(): boolean {
    return has('debugger.attach');
  },
};
