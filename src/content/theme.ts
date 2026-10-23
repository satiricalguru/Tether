import type { Theme } from '@/lib/settings';

/**
 * Tether's on-page UIs (bubble, compose) follow the theme setting like the
 * panel does: `data-theme` on their shadow host, unset for "system" so the
 * OS decides. Their styles put dark colours behind `darkRule`.
 */

let current: Theme = 'system';
const hosts = new Set<HTMLElement>();

function apply(host: HTMLElement): void {
  if (current === 'system') host.removeAttribute('data-theme');
  else host.setAttribute('data-theme', current);
}

export function setPageTheme(theme: Theme): void {
  current = theme;
  for (const h of hosts) apply(h);
}

/** Keep a shadow host's theme in step with the setting. Returns a release function. */
export function themeHost(host: HTMLElement): () => void {
  hosts.add(host);
  apply(host);
  return () => {
    hosts.delete(host);
  };
}

/** CSS applying `declarations` to `selector` in dark mode: chosen in settings, or the OS's under "system". */
export function darkRule(selector: string, declarations: string): string {
  return (
    `:host([data-theme="dark"]) ${selector} { ${declarations} }\n` +
    `@media (prefers-color-scheme: dark) { :host(:not([data-theme="light"])) ${selector} { ${declarations} } }`
  );
}
