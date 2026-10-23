import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The generated Firefox manifest (`pnpm test:firefox` builds it first).
 * Firefox refuses or warns on Chromium-only keys and permissions, and the
 * side panel must become a sidebar. Skipped when scanning the Chrome build.
 */

const OUT = resolve(
  import.meta.dirname,
  '../..',
  process.env.TETHER_OUT_DIR ?? '.output',
  'firefox-mv3',
);

interface Manifest {
  manifest_version: number;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  background?: { scripts?: string[]; service_worker?: string; type?: string };
  sidebar_action?: { default_panel?: string; default_title?: string };
  side_panel?: unknown;
  action?: { default_popup?: string };
  commands?: Record<string, unknown>;
  minimum_chrome_version?: string;
  content_security_policy?: { extension_pages?: string };
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
}

const CHROMIUM_ONLY_PERMISSIONS = ['sidePanel', 'offscreen', 'debugger'];

describe.runIf(process.env.TETHER_BUNDLE === 'firefox-mv3')('Firefox manifest', () => {
  const read = (): Manifest =>
    JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as Manifest;

  it('exists (run `pnpm build:firefox` first)', () => {
    expect(existsSync(join(OUT, 'manifest.json'))).toBe(true);
  });

  it('is MV3 with a gecko id and a minimum version', () => {
    const m = read();
    expect(m.manifest_version).toBe(3);
    expect(m.browser_specific_settings?.gecko?.id).toMatch(/@/);
    expect(
      Number.parseFloat(m.browser_specific_settings?.gecko?.strict_min_version ?? '0'),
    ).toBeGreaterThanOrEqual(128);
  });

  it('has no Chromium-only keys or permissions', () => {
    const m = read();
    expect(m.side_panel).toBeUndefined();
    expect(m.minimum_chrome_version).toBeUndefined();
    const all = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];
    for (const p of CHROMIUM_ONLY_PERMISSIONS) expect(all).not.toContain(p);
  });

  it('opens the panel as a sidebar, from the toolbar and the shortcut', () => {
    const m = read();
    expect(m.sidebar_action?.default_panel).toBe('sidepanel.html');
    expect(existsSync(join(OUT, 'sidepanel.html'))).toBe(true);
    // No popup, so a toolbar click reaches action.onClicked, which toggles the sidebar.
    expect(m.action?.default_popup).toBeUndefined();
    expect(m.commands).toHaveProperty('_execute_sidebar_action');
    expect(m.commands).not.toHaveProperty('_execute_action');
  });

  it('runs the background as event-page scripts, not a service worker', () => {
    const m = read();
    expect(m.background?.service_worker).toBeUndefined();
    expect(m.background?.scripts?.length).toBeGreaterThan(0);
    for (const s of m.background?.scripts ?? []) expect(existsSync(join(OUT, s))).toBe(true);
  });

  it('asks for the same host access as Chrome: local hosts now, all sites only on request', () => {
    const m = read();
    expect(m.host_permissions).toEqual([
      'http://localhost/*',
      'http://127.0.0.1/*',
      'http://[::1]/*',
    ]);
    expect(m.optional_host_permissions).toEqual(['<all_urls>']);
    expect(m.content_security_policy?.extension_pages).toBe(
      "script-src 'self'; object-src 'self';",
    );
  });
});
