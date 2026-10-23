import { TETHER_UI_ATTRIBUTE } from '@/context/extract';
import { sendMessage } from '@/lib/messaging';

/**
 * "Tether is controlling this tab" — shown on every tab under agent control
 * (spec §6.6 kill switch). Stop and Esc end the run. Closed shadow root:
 * the page can't restyle, hide or click it.
 *
 * Page scripts can't trigger Stop either: the button only responds to
 * trusted events (a real user click or key press).
 */

const STYLE = `
:host { all: initial; }
.bar { position: fixed; z-index: 2147483647; top: 8px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 12px; border-radius: 999px;
  background: #1c1c1a; color: #fff; font: 12px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.25); pointer-events: auto; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ececec; animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .35; } }
button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: #c62828; color: #fff; font-weight: 600; }
button:focus-visible { outline: 2px solid #fff; }
.hint { opacity: .7; }
`;

let host: HTMLElement | null = null;
let currentRun = '';
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

function stop() {
  void sendMessage('bg:agent:stop', { runId: currentRun });
  hideBanner();
}

export function showBanner(runId: string): void {
  currentRun = runId;
  if (host) return;
  host = document.createElement('tether-agent-banner');
  host.setAttribute(TETHER_UI_ATTRIBUTE, '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'status');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = 'Tether is controlling this tab';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Esc to stop';
  const btn = document.createElement('button');
  btn.textContent = 'Stop';
  btn.addEventListener('click', (e) => {
    if (e.isTrusted) stop();
  });
  bar.append(dot, text, hint, btn);
  root.append(style, bar);
  document.documentElement.append(host);
  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && e.isTrusted) stop();
  };
  window.addEventListener('keydown', keyHandler, true);
}

export function hideBanner(): void {
  host?.remove();
  host = null;
  if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
}
