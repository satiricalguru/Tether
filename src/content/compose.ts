import { setNativeValue } from '@/agent/page/actions';
import { isSensitiveField } from '@/agent/page/snapshot';
import { diffStats, wordDiff } from '@/compose/diff';
import { cleanOutput, MODE_LABELS, type ComposeMode } from '@/compose/prompt';
import { TETHER_UI_ATTRIBUTE } from '@/context/extract';
import { openStream, type StreamHandle } from '@/lib/ports';
import { darkRule, themeHost } from './theme';

/**
 * Inline compose: Cmd/Ctrl+K in a text field opens a small popover to
 * rewrite, shorten, fix or re-tone the selection (else the whole field), or
 * to write new text into an empty one. The result streams in as a word diff
 * and changes nothing until Accept.
 *
 * Same rules as the bubble: plain DOM in a closed shadow root, text only via
 * textContent, the model call runs in the background (`compose` stream).
 * The host exposes nothing but `data-state` (closed / open / running /
 * ready / error). It never opens in password, one-time-code or card fields.
 */

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483647; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #0d0d0d; --bg: #ffffff; --bd: #e5e5e5; --mut: #5d5d5d; --acc: #0d0d0d; --accfg: #ffffff; --s2: #f4f4f4;
  --add: #e6f4ea; --addfg: #1b5e20; --del: #fdecea; --delfg: #8e1b1b; }
${darkRule('.wrap', 'color: #ececec; --bg: #2f2f2f; --bd: #424242; --mut: #b4b4b4; --acc: #ececec; --accfg: #0d0d0d; --s2: #3a3a3a; --add: #1f3a26; --addfg: #a5d6a7; --del: #3d1f1f; --delfg: #ef9a9a;')}
.card { width: min(460px, calc(100vw - 16px)); max-height: min(60vh, 520px); display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--bd); border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.22); }
.head { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px 0; }
.logo { font-weight: 600; color: var(--acc); }
.scope { color: var(--mut); font-size: 12px; }
.ask { display: flex; gap: 4px; padding: 6px 8px; }
.ask input { all: unset; flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--bd); border-radius: 7px; background: var(--s2); }
.ask input:focus-visible { outline: 2px solid var(--acc); outline-offset: -1px; }
.modes { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 6px 6px; }
button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 7px; font-size: 12px; color: inherit; white-space: nowrap; }
button:hover, button:focus-visible { background: var(--s2); }
button:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
button.primary { background: var(--acc); color: var(--accfg); }
button[disabled] { opacity: .45; cursor: default; }
.result { border-top: 1px solid var(--bd); padding: 8px 10px; overflow: auto; white-space: pre-wrap; word-wrap: break-word; }
.status { color: var(--mut); font-size: 12px; }
.err { color: #c62828; }
ins { text-decoration: underline; text-decoration-thickness: 2px; background: var(--add); color: var(--addfg); }
del { text-decoration: line-through; background: var(--del); color: var(--delfg); }
.foot { display: flex; align-items: center; gap: 4px; padding: 6px; border-top: 1px solid var(--bd); }
.stats { flex: 1; color: var(--mut); font-size: 11px; padding-left: 4px; }
`;

const STATUS: Record<string, string> = {
  waiting: 'Writing…',
  'loading-model': 'Loading model… (first use can take a minute)',
  slow: 'Writing…',
};

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel']);
/** Fields named like secrets: never offered, whatever their type. */
const SECRET_NAME =
  /pass(word|code|phrase)|\bpin\b|\botp\b|one.?time|\bcvc\b|\bcvv\b|security.?code|card.?number|\biban\b|\bssn\b/i;

type Field = HTMLInputElement | HTMLTextAreaElement;

/** What compose acts on, captured when it opens. */
export type EditTarget =
  | {
      kind: 'field';
      el: Field;
      /** The replaced range (the whole value when nothing was selected). */
      start: number;
      end: number;
      /** The field's whole value at open, to notice edits made meanwhile. */
      whole: string;
      text: string;
      selection: boolean;
    }
  | {
      kind: 'editable';
      el: HTMLElement;
      /** The selected range, or null for the whole element. */
      range: Range | null;
      whole: string;
      text: string;
      selection: boolean;
    };

function isField(el: Element): el is Field {
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
}

/** The outermost contenteditable element containing `el`, if any. */
export function editableHost(el: Element): HTMLElement | null {
  const sel = '[contenteditable]:not([contenteditable="false"])';
  let host = el.closest<HTMLElement>(sel);
  while (host?.parentElement) {
    const up = host.parentElement.closest<HTMLElement>(sel);
    if (!up) break;
    host = up;
  }
  return host;
}

function looksSecret(el: Element): boolean {
  if (isSensitiveField(el)) return true;
  const attrs = ['name', 'id', 'aria-label', 'placeholder', 'autocomplete']
    .map((a) => el.getAttribute(a) ?? '')
    .join(' ');
  return SECRET_NAME.test(attrs);
}

/** The element compose would act on for `el`, or null if it isn't a text field it may touch. */
export function composeTarget(el: Element | null): Field | HTMLElement | null {
  if (!el) return null;
  if (isField(el)) {
    if (el.readOnly || el.disabled) return null;
    if (
      el.tagName === 'INPUT' &&
      !TEXT_INPUT_TYPES.has((el as HTMLInputElement).type.toLowerCase())
    )
      return null;
    return looksSecret(el) ? null : el;
  }
  const host = editableHost(el);
  if (!host || looksSecret(host)) return null;
  return host;
}

/** The focused element, looking inside open shadow roots. */
export function deepActiveElement(doc: Document): Element | null {
  let a = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function textOf(el: HTMLElement): string {
  // innerText keeps line breaks the way the user sees them (jsdom lacks it).
  return el.innerText || el.textContent || '';
}

export function captureTarget(el: Field | HTMLElement): EditTarget {
  if (isField(el)) {
    const whole = el.value;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    const selection = e > s;
    return {
      kind: 'field',
      el,
      start: selection ? s : 0,
      end: selection ? e : whole.length,
      whole,
      text: selection ? whole.slice(s, e) : whole,
      selection,
    };
  }
  const whole = textOf(el);
  const sel = el.ownerDocument.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (range && !range.collapsed && el.contains(range.commonAncestorContainer)) {
    return {
      kind: 'editable',
      el,
      range: range.cloneRange(),
      whole,
      text: range.toString(),
      selection: true,
    };
  }
  return { kind: 'editable', el, range: null, whole, text: whole, selection: false };
}

function execInsert(doc: Document, text: string): boolean {
  try {
    // Deprecated but still the one way to edit that undo stacks and editors' handlers see.
    /* eslint-disable @typescript-eslint/no-deprecated */
    if (typeof doc.execCommand !== 'function') return false;
    return text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete', false);
    /* eslint-enable @typescript-eslint/no-deprecated */
  } catch {
    return false;
  }
}

function fireInput(el: Element, data: string): void {
  const W = el.ownerDocument.defaultView ?? window;
  el.dispatchEvent(
    new W.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data }),
  );
}

/**
 * Put `text` in place of the target's range. Goes through execCommand so
 * Undo works and frameworks see real input; falls back to the native value
 * setter (React-style controlled inputs) plus an input event.
 */
export function applyText(
  t: EditTarget,
  text: string,
): { ok: true } | { ok: false; error: string } {
  const doc = t.el.ownerDocument;
  if (t.kind === 'field') {
    const el = t.el;
    if (el.value !== t.whole) {
      return { ok: false, error: 'The field changed while Tether was writing. Run it again.' };
    }
    const expected = t.whole.slice(0, t.start) + text + t.whole.slice(t.end);
    el.focus();
    let selected = true;
    try {
      el.setSelectionRange(t.start, t.end);
    } catch {
      // email/url inputs have no selection API.
      selected = false;
    }
    if (!selected || !execInsert(doc, text) || el.value !== expected) {
      setNativeValue(el, expected);
      fireInput(el, text);
    }
    try {
      el.setSelectionRange(t.start + text.length, t.start + text.length);
    } catch {
      // no selection API
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  const el = t.el;
  if (!el.isConnected) return { ok: false, error: 'The field is gone. Run it again.' };
  el.focus();
  const sel = doc.getSelection();
  const range = t.range ?? doc.createRange();
  if (!t.range) range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  if (!execInsert(doc, text)) {
    range.deleteContents();
    const frag = doc.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i > 0) frag.append(doc.createElement('br'));
      if (line) frag.append(doc.createTextNode(line));
    });
    range.insertNode(frag);
    range.collapse(false);
    fireInput(el, text);
  }
  return { ok: true };
}

const isMac = () => {
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(ua.userAgentData?.platform ?? navigator.userAgent);
};

/** Cmd+K on macOS, Ctrl+K elsewhere, nothing else held. */
export function isComposeShortcut(e: KeyboardEvent, mac = isMac()): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || e.isComposing) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export interface ComposeOptions {
  /** Whether Cmd/Ctrl+K may open it right now (setting on, extension alive). */
  enabled: () => boolean;
  /** Closed in pages; tests open it to look inside. */
  shadowMode?: ShadowRootMode;
}

export interface ComposeHandle {
  /** Open on this element if it's a field compose may edit (the context menu ignores `enabled`). */
  openFor: (el: Element | null) => boolean;
  dispose: () => void;
}

export function installCompose(opts: ComposeOptions): ComposeHandle {
  let host: HTMLElement | null = null;
  let releaseTheme: (() => void) | undefined;
  let wrap: HTMLDivElement | null = null;
  let target: EditTarget | null = null;
  let stream: StreamHandle<'compose'> | undefined;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const setState = (s: 'closed' | 'open' | 'running' | 'ready' | 'error') => {
    host?.setAttribute('data-state', s);
  };

  const ensureHost = () => {
    if (host?.isConnected && wrap) return wrap;
    releaseTheme?.();
    host = document.createElement('tether-compose');
    host.setAttribute(TETHER_UI_ATTRIBUTE, '');
    releaseTheme = themeHost(host);
    const root = host.attachShadow({ mode: opts.shadowMode ?? 'closed' });
    const style = el('style');
    style.textContent = STYLE;
    wrap = el('div', 'wrap');
    wrap.hidden = true;
    // Keys typed in the popover are ours, not the page's shortcuts.
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
      e.stopPropagation();
    });
    root.append(style, wrap);
    document.documentElement.append(host);
    return wrap;
  };

  const close = (refocus: boolean) => {
    stream?.abort();
    stream = undefined;
    const t = target;
    target = null;
    if (wrap) {
      wrap.hidden = true;
      wrap.replaceChildren();
    }
    setState('closed');
    if (refocus && t) {
      t.el.focus();
      if (t.kind === 'field' && t.selection) {
        try {
          t.el.setSelectionRange(t.start, t.end);
        } catch {
          // no selection API
        }
      }
    }
  };

  const place = (card: HTMLElement, anchor: DOMRect) => {
    if (!wrap) return;
    const h = card.offsetHeight || 260;
    const w = card.offsetWidth || 460;
    const x = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - w - 8));
    const below = anchor.bottom + 6;
    const above = anchor.top - 6 - h;
    const y = below + h <= window.innerHeight - 8 ? below : above >= 8 ? above : 8;
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;
  };

  const open = (t: EditTarget) => {
    const box = ensureHost();
    stream?.abort();
    target = t;
    box.replaceChildren();
    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Tether compose');

    const head = el('div', 'head');
    head.append(
      el('span', 'logo', 'Tether'),
      el(
        'span',
        'scope',
        t.text.trim() ? (t.selection ? 'Selected text' : 'Whole field') : 'New text',
      ),
    );

    const ask = el('div', 'ask');
    const input = el('input');
    input.placeholder = t.text.trim()
      ? 'Tell Tether how to change it…'
      : 'Tell Tether what to write…';
    input.setAttribute('aria-label', 'Instruction');
    const go = el('button', 'primary', t.text.trim() ? 'Change' : 'Write');
    ask.append(input, go);

    const modes = el('div', 'modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Quick changes');
    if (t.text.trim()) {
      for (const [mode, label] of Object.entries(MODE_LABELS) as [
        Exclude<ComposeMode, 'prompt'>,
        string,
      ][]) {
        const b = el('button', undefined, label);
        b.dataset.mode = mode;
        b.onclick = () => {
          run(mode);
        };
        modes.append(b);
      }
    }

    const result = el('div', 'result');
    result.hidden = true;
    result.setAttribute('aria-live', 'polite');
    const status = el('div', 'status');
    const diff = el('div');
    diff.setAttribute('aria-label', 'Preview');
    result.append(status, diff);

    const foot = el('div', 'foot');
    foot.hidden = true;
    const stats = el('span', 'stats');
    const accept = el('button', 'primary', 'Accept');
    const again = el('button', undefined, 'Regenerate');
    const reject = el('button', undefined, 'Reject');
    foot.append(stats, accept, again, reject);

    card.append(head, ask, modes, result, foot);
    box.append(card);
    box.hidden = false;
    setState('open');
    place(card, t.el.getBoundingClientRect());
    input.focus();

    let output = '';
    let last: { mode: ComposeMode; instruction?: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const render = (text: string) => {
      diff.replaceChildren();
      for (const part of wordDiff(t.text, text)) {
        if (part.op === 'same') diff.append(document.createTextNode(part.text));
        else diff.append(el(part.op === 'add' ? 'ins' : 'del', undefined, part.text));
      }
      const { added, removed } = diffStats(wordDiff(t.text, text));
      stats.textContent = t.text.trim()
        ? `${removed} word${removed === 1 ? '' : 's'} removed, ${added} added`
        : `${added} word${added === 1 ? '' : 's'}`;
    };
    const scheduleRender = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        render(cleanOutput(output));
      }, 80);
    };

    const run = (mode: ComposeMode, instruction?: string) => {
      stream?.abort();
      last = { mode, ...(instruction ? { instruction } : {}) };
      output = '';
      result.hidden = false;
      foot.hidden = false;
      diff.replaceChildren();
      stats.textContent = '';
      status.hidden = false;
      status.className = 'status';
      status.textContent = STATUS.waiting ?? '';
      accept.disabled = true;
      again.disabled = true;
      setState('running');
      const s = openStream('compose', {
        mode,
        ...(instruction ? { instruction } : {}),
        text: t.text,
        ...(t.selection ? { context: t.whole } : {}),
        url: location.href,
        title: document.title,
      });
      stream = s;
      void (async () => {
        try {
          for await (const ev of s) {
            if (ev.type === 'status') {
              status.textContent = STATUS[ev.status] ?? '';
              status.hidden = ev.status === 'generating';
            } else if (ev.type === 'text') {
              status.hidden = true;
              output += ev.text;
              scheduleRender();
            } else if (ev.type === 'reclassify-reasoning') {
              output = '';
              scheduleRender();
            }
          }
          await s.done;
          if (stream !== s) return;
          if (timer) clearTimeout(timer);
          timer = undefined;
          const final = cleanOutput(output);
          output = final;
          render(final);
          again.disabled = false;
          if (!final.trim()) {
            status.hidden = false;
            status.className = 'status err';
            status.textContent = 'The model returned no text. Try again or rephrase.';
            setState('error');
            again.focus();
            return;
          }
          accept.disabled = false;
          setState('ready');
          accept.focus();
        } catch (err) {
          if ((err as Error).name === 'AbortError' || stream !== s) return;
          status.hidden = false;
          status.className = 'status err';
          status.textContent = (err as Error).message;
          again.disabled = false;
          setState('error');
          again.focus();
        }
      })();
    };

    const submit = () => {
      const text = input.value.trim();
      if (text) run('prompt', text);
    };
    go.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    again.onclick = () => {
      if (last) run(last.mode, last.instruction);
    };
    reject.onclick = () => {
      close(true);
    };
    accept.onclick = () => {
      if (accept.disabled) return;
      const r = applyText(t, output);
      if (!r.ok) {
        status.hidden = false;
        status.className = 'status err';
        status.textContent = r.error;
        accept.disabled = true;
        setState('error');
        return;
      }
      close(false);
    };
  };

  const openFor = (elem: Element | null): boolean => {
    const field = composeTarget(elem);
    if (!field) return false;
    open(captureTarget(field));
    return true;
  };

  const onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted || !isComposeShortcut(e)) return;
    if (host && e.composedPath().includes(host)) return;
    if (!opts.enabled()) return;
    // Only inside a text field we may edit: elsewhere Cmd/Ctrl+K is the page's.
    const field = composeTarget(deepActiveElement(document));
    if (!field) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open(captureTarget(field));
  };
  const onMouseDown = (e: MouseEvent) => {
    if (target && host && !e.composedPath().includes(host)) close(false);
  };

  window.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouseDown, true);

  return {
    openFor,
    dispose: () => {
      close(false);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      host?.remove();
      releaseTheme?.();
      host = null;
      wrap = null;
    },
  };
}
