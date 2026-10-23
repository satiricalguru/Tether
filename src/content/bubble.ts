import { browser } from 'wxt/browser';
import { TETHER_UI_ATTRIBUTE } from '@/context/extract';
import { sendMessage } from '@/lib/messaging';
import { openStream, type StreamHandle } from '@/lib/ports';
import { darkRule, themeHost } from './theme';
import { QUICK_ACTIONS, type QuickAction } from '@/prompting/actions';

/**
 * Highlight-to-ask. Plain DOM in a closed shadow root: site CSS can't reach
 * in, the page can't read or script it, and no framework is injected into
 * every page. The model call runs in the background (`quick` stream); this
 * file only shows buttons and renders streamed text with textContent.
 */

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483647; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #0d0d0d; --bg: #ffffff; --bd: #e5e5e5; --mut: #5d5d5d; --acc: #0d0d0d; --accfg: #ffffff; --s2: #f4f4f4; }
${darkRule('.wrap', 'color: #ececec; --bg: #2f2f2f; --bd: #424242; --mut: #b4b4b4; --acc: #ececec; --accfg: #0d0d0d; --s2: #3a3a3a;')}
.bar { display: flex; gap: 2px; padding: 3px; background: var(--bg); border: 1px solid var(--bd); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); }
button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 7px; font-size: 12px; color: inherit; white-space: nowrap; }
button:hover, button:focus-visible { background: var(--s2); }
button.primary { background: var(--acc); color: var(--accfg); }
.logo { padding: 4px 6px; font-weight: 600; color: var(--acc); }
.card { margin-top: 6px; width: min(420px, calc(100vw - 24px)); max-height: 50vh; display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--bd); border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.22); }
.body { padding: 10px 12px; overflow: auto; white-space: pre-wrap; word-wrap: break-word; }
.status { color: var(--mut); font-size: 12px; }
.err { color: #c62828; }
.foot { display: flex; gap: 4px; padding: 6px; border-top: 1px solid var(--bd); justify-content: flex-end; }
.ask { display: flex; gap: 4px; padding: 6px; }
.ask input { all: unset; flex: 1; padding: 4px 8px; border: 1px solid var(--bd); border-radius: 7px; background: var(--s2); min-width: 0; }
.hint { color: var(--mut); font-size: 11px; padding: 0 12px 8px; }
`;

const STATUS: Record<string, string> = {
  waiting: 'Thinking…',
  'loading-model': 'Loading model… (first use can take a minute)',
  slow: 'Reading…',
};

export interface BubbleOptions {
  /** Called to decide whether the bubble may show right now (setting toggled off etc). */
  enabled: () => boolean;
}

export function installBubble(opts: BubbleOptions): () => void {
  const host = document.createElement('tether-bubble');
  host.setAttribute(TETHER_UI_ATTRIBUTE, '');
  const releaseTheme = themeHost(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.hidden = true;
  root.append(style, wrap);
  document.documentElement.append(host);

  let selection = '';
  let stream: StreamHandle<'quick'> | undefined;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const hide = () => {
    stream?.abort();
    stream = undefined;
    wrap.hidden = true;
    wrap.replaceChildren();
  };

  const place = (rect: DOMRect) => {
    const x = Math.min(Math.max(8, rect.left), window.innerWidth - 440);
    const below = rect.bottom + 8;
    const y = below + 60 < window.innerHeight ? below : Math.max(8, rect.top - 48);
    wrap.style.left = `${Math.max(8, x)}px`;
    wrap.style.top = `${y}px`;
  };

  const run = (action: QuickAction, question?: string) => {
    const card = el('div', 'card');
    const body = el('div', 'body');
    const status = el('div', 'status', STATUS.waiting);
    const text = el('span');
    body.append(status, text);
    const foot = el('div', 'foot');
    const copy = el('button', undefined, 'Copy');
    const cont = el('button', 'primary', 'Continue in side panel');
    const close = el('button', undefined, 'Close');
    foot.append(copy, cont, close);
    const hint = el('div', 'hint');
    hint.hidden = true;
    card.append(body, foot, hint);
    wrap.querySelector('.card')?.remove();
    wrap.querySelector('.ask')?.remove();
    wrap.append(card);

    let answer = '';
    let prompt = '';
    copy.disabled = true;
    cont.disabled = true;
    copy.onclick = () => void navigator.clipboard.writeText(answer);
    close.onclick = hide;
    cont.onclick = () => {
      void sendMessage('bg:pending:continue', {
        selection,
        prompt,
        answer,
        url: location.href,
        title: document.title,
      }).then(({ opened }) => {
        if (opened) hide();
        else {
          hint.hidden = false;
          hint.textContent =
            'Saved. Open the Tether side panel (toolbar button or Ctrl/⌘+Shift+L) to continue.';
        }
      });
    };

    stream = openStream('quick', {
      action,
      selection,
      ...(question ? { question } : {}),
      url: location.href,
      title: document.title,
    });
    const s = stream;
    void (async () => {
      try {
        for await (const ev of s) {
          if (ev.type === 'status') {
            status.textContent = STATUS[ev.status] ?? '';
            status.hidden = ev.status === 'generating';
          } else if (ev.type === 'text') {
            status.hidden = true;
            answer += ev.text;
            text.textContent = answer;
          } else if (ev.type === 'reclassify-reasoning') {
            answer = '';
            text.textContent = '';
          }
        }
        prompt = (await s.done).prompt;
        copy.disabled = false;
        cont.disabled = false;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        status.hidden = false;
        status.className = 'status err';
        status.textContent = (err as Error).message;
      }
    })();
  };

  const showBar = () => {
    wrap.replaceChildren();
    const bar = el('div', 'bar');
    bar.append(el('span', 'logo', 'Tether'));
    for (const a of QUICK_ACTIONS) {
      const b = el('button', undefined, a.label);
      b.dataset.action = a.id;
      b.onclick = () => {
        if (a.id !== 'ask') {
          run(a.id);
          return;
        }
        const ask = el('div', 'ask');
        const input = el('input');
        input.placeholder = 'Ask about the selection…';
        const go = el('button', 'primary', 'Ask');
        const submit = () => {
          if (input.value.trim()) run('ask', input.value.trim());
        };
        go.onclick = submit;
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') hide();
        };
        wrap.querySelector('.ask')?.remove();
        wrap.append(ask);
        ask.append(input, go);
        input.focus();
      };
      bar.append(b);
    }
    wrap.append(bar);
    wrap.hidden = false;
  };

  const onMouseUp = (e: MouseEvent) => {
    // Clicks inside the bubble arrive retargeted to the host.
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      if (!opts.enabled()) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || text.length < 2 || sel.rangeCount === 0) {
        if (!stream) hide();
        return;
      }
      if (stream && text === selection) return;
      hide();
      selection = text.slice(0, 20_000);
      place(sel.getRangeAt(0).getBoundingClientRect());
      showBar();
    }, 0);
  };
  const onMouseDown = (e: MouseEvent) => {
    if (!e.composedPath().includes(host)) hide();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !wrap.hidden) hide();
  };

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKey, true);

  return () => {
    hide();
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    releaseTheme();
  };
}

/** True while this content script's extension context is still valid. */
export function runtimeAlive(): boolean {
  try {
    return !!browser.runtime.id;
  } catch {
    return false;
  }
}
