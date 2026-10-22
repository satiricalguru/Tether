import { extractPage, isHidden, TETHER_UI_ATTRIBUTE } from '@/context/extract';
import { estimateTokens } from '@/context/tokens';
import type { FrameInfo, PageSnapshot, Rect, SnapshotElement, SnapshotOptions } from './types';

/**
 * Page → the agent's action space. Runs in the page (content script).
 *
 * Every interactive element a person can see (or could scroll to soon) gets a
 * small per-snapshot id. The model acts on ids; the element behind each id
 * lives only in this script's registry, so actions never depend on brittle
 * selectors and the page can't spoof them.
 */

// ---------- registry ----------

interface Entry {
  el: WeakRef<Element>;
  /** Where to send pointer events, when that isn't the element itself (label of a hidden checkbox). */
  target?: WeakRef<Element>;
}

let registry = new Map<string, Entry>();

/** The element behind an id from the most recent snapshot. */
export function resolveElement(id: string): Element | undefined {
  const el = registry.get(id)?.el.deref();
  return el?.isConnected ? el : undefined;
}

/** The element to click for an id (a visible label stands in for a hidden native input). */
export function resolveTarget(id: string): Element | undefined {
  const entry = registry.get(id);
  const target = entry?.target?.deref();
  if (target?.isConnected) return target;
  return resolveElement(id);
}

/** Was this id in the most recent snapshot (listed or trimmed)? */
export function hasId(id: string): boolean {
  return registry.has(id);
}

// ---------- candidates ----------

const WIDGET_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'textbox',
  'searchbox',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'listbox',
]);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

const TEXT_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'password', '']);

const MAX_VISITED = 20_000;
const MAX_POINTER_CANDIDATES = 60;

function explicitRole(el: Element): string | undefined {
  const first = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  return first && WIDGET_ROLES.has(first) ? first : undefined;
}

function isEditable(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}

/** Is `el` interactive by markup alone (not counting cursor:pointer)? */
function isCandidate(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'A') return el.hasAttribute('href');
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden';
  if (explicitRole(el)) return true;
  if (el.hasAttribute('onclick')) return true;
  if (isEditable(el)) {
    // Only the editing host, not every descendant of it.
    const parent = el.parentElement;
    return !parent || !isEditable(parent);
  }
  return false;
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  // Inside a disabled fieldset (except its first legend).
  const fs = el.closest('fieldset');
  if (fs?.disabled) {
    const legend = fs.querySelector(':scope > legend');
    if (!legend?.contains(el)) return true;
  }
  return false;
}

// ---------- roles, names, values ----------

export function roleOf(el: Element): string {
  const explicit = explicitRole(el);
  if (explicit) return explicit;
  const tag = el.tagName;
  switch (tag) {
    case 'A':
      return 'link';
    case 'BUTTON':
    case 'SUMMARY':
      return 'button';
    case 'TEXTAREA':
      return 'textbox';
    case 'SELECT': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'INPUT': {
      const type = (el as HTMLInputElement).type.toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'file') return 'button';
      return 'textbox';
    }
  }
  if (isEditable(el)) return 'textbox';
  return 'clickable';
}

function collapse(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Visible text: innerText where the engine has layout, textContent otherwise (jsdom). */
function visibleText(el: Element): string {
  const it = (el as HTMLElement).innerText as string | undefined;
  return collapse(typeof it === 'string' ? it : el.textContent);
}

function textOfIds(el: Element, ids: string): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => {
      const ref = root.getElementById(id) ?? el.ownerDocument.getElementById(id);
      return ref ? visibleText(ref) : '';
    })
    .filter(Boolean)
    .join(' ');
}

function labelText(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (!labels || labels.length === 0) return '';
  const parts: string[] = [];
  for (const label of labels) {
    // A wrapping label also contains the control's own text (select options…).
    let t = visibleText(label);
    const own = el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? visibleText(el) : '';
    if (own && t.includes(own)) t = collapse(t.replace(own, ''));
    if (t) parts.push(t);
  }
  return parts.join(' ');
}

function nearestHeading(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 6; depth++) {
    let sib = node.previousElementSibling;
    for (let i = 0; sib && i < 8; i++) {
      if (/^H[1-6]$/.test(sib.tagName)) return visibleText(sib);
      const inner = sib.querySelector('h1,h2,h3,h4,h5,h6');
      if (inner) return visibleText(inner);
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

export function accessibleName(el: Element): string {
  const tag = el.tagName;
  const labelledby = el.getAttribute('aria-labelledby');
  const candidates: (() => string)[] = [
    () => (labelledby ? textOfIds(el, labelledby) : ''),
    () => collapse(el.getAttribute('aria-label')),
    () => (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ? labelText(el) : ''),
    () => collapse(el.getAttribute('placeholder')),
    () => {
      if (tag !== 'INPUT') return '';
      const input = el as HTMLInputElement;
      if (['submit', 'button', 'reset'].includes(input.type)) {
        return collapse(input.value) || (input.type === 'submit' ? 'Submit' : '');
      }
      if (input.type === 'image') return collapse(input.alt);
      return '';
    },
    () => (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ? '' : visibleText(el)),
    () => collapse(el.getAttribute('title')),
    () => collapse(el.querySelector('img[alt]')?.getAttribute('alt')),
    () => collapse(el.querySelector('svg title')?.textContent),
    () => {
      const h = nearestHeading(el);
      return h ? `near: ${h}` : '';
    },
  ];
  for (const c of candidates) {
    const v = c();
    if (v) return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  }
  return '';
}

const SENSITIVE_AUTOCOMPLETE =
  /\b(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|one-time-code|current-password|new-password)\b/i;

export function isSensitiveField(el: Element): boolean {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type.toLowerCase() === 'password')
    return true;
  return SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '');
}

function valueOf(el: Element): string | undefined {
  const tag = el.tagName;
  let v: string | undefined;
  if (tag === 'SELECT') {
    const s = el as HTMLSelectElement;
    v = [...s.selectedOptions].map((o) => collapse(o.textContent)).join(', ');
  } else if (tag === 'TEXTAREA') {
    v = (el as HTMLTextAreaElement).value;
  } else if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = input.type.toLowerCase();
    if (['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type))
      return undefined;
    if (isSensitiveField(el)) return input.value ? '••••' : undefined;
    v = input.value;
  } else if (isEditable(el)) {
    v = visibleText(el);
  } else if (el.getAttribute('aria-valuenow') !== null) {
    v = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? undefined;
  }
  if (!v) return undefined;
  const c = v.replace(/\s+/g, ' ');
  return c.length > 60 ? `${c.slice(0, 59)}…` : c;
}

function stateOf(el: Element, role: string): string[] {
  const out: string[] = [];
  const checkedAttr = el.getAttribute('aria-checked');
  if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) {
    out.push((el as HTMLInputElement).checked ? 'checked' : 'unchecked');
  } else if (checkedAttr !== null) {
    out.push(checkedAttr === 'true' ? 'checked' : checkedAttr === 'mixed' ? 'mixed' : 'unchecked');
  } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    out.push('unchecked');
  }
  const pressed = el.getAttribute('aria-pressed');
  if (pressed === 'true') out.push('pressed');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') out.push('expanded');
  else if (expanded === 'false') out.push('collapsed');
  if (el.tagName === 'SUMMARY') {
    const details = el.parentElement;
    if (details?.tagName === 'DETAILS')
      out.push((details as HTMLDetailsElement).open ? 'expanded' : 'collapsed');
  }
  if (
    el.getAttribute('aria-selected') === 'true' ||
    (el.tagName === 'OPTION' && (el as HTMLOptionElement).selected)
  ) {
    out.push('selected');
  }
  if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true')
    out.push('required');
  if ((el as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true')
    out.push('readonly');
  return out;
}

function headingText(el: Element): string {
  const h = el.querySelector('legend, h1, h2, h3, h4, h5, h6');
  return h ? visibleText(h) : '';
}

function containerName(el: Element): string {
  const labelledby = el.getAttribute('aria-labelledby');
  const name =
    (labelledby ? textOfIds(el, labelledby) : '') ||
    collapse(el.getAttribute('aria-label')) ||
    headingText(el) ||
    collapse(el.getAttribute('name'));
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';

function closestAcrossShadow(el: Element, selector: string): Element | null {
  let node: Element | null = el;
  while (node) {
    const found = node.closest(selector);
    if (found) return found;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function hintOf(el: Element, frame: number | undefined): string | undefined {
  const parts: string[] = [];
  if (frame !== undefined) parts.push(`in frame ${frame}`);
  const dialog = closestAcrossShadow(el, DIALOG_SELECTOR);
  const form = (el as HTMLInputElement).form ?? closestAcrossShadow(el, 'form');
  if (dialog) {
    const n = containerName(dialog);
    parts.push(n ? `in dialog ${JSON.stringify(n)}` : 'in dialog');
  } else if (form) {
    const n = containerName(form);
    parts.push(n ? `in form ${JSON.stringify(n)}` : 'in form');
  } else if (closestAcrossShadow(el, 'nav, [role="navigation"]')) {
    parts.push('in nav');
  } else if (closestAcrossShadow(el, 'header, [role="banner"]')) {
    parts.push('in header');
  } else if (closestAcrossShadow(el, 'footer, [role="contentinfo"]')) {
    parts.push('in footer');
  }
  return parts.length ? parts.join(', ') : undefined;
}

function optionsOf(el: Element): string[] | undefined {
  let opts: string[] = [];
  if (el.tagName === 'SELECT') {
    opts = [...(el as HTMLSelectElement).options].map((o) => collapse(o.textContent));
  } else {
    const role = roleOf(el);
    if (role === 'listbox' || role === 'combobox') {
      const controls = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
      const scope = controls ? el.ownerDocument.getElementById(controls.split(/\s+/)[0] ?? '') : el;
      opts = [...(scope?.querySelectorAll('[role="option"]') ?? [])].map((o) => visibleText(o));
    }
  }
  opts = opts.filter(Boolean);
  return opts.length ? opts.slice(0, 10) : undefined;
}

// ---------- geometry ----------

interface FrameCtx {
  /** 1-based frame index; undefined for the top document. */
  index?: number;
  win: Window;
  /** Offset of this frame's viewport inside the top-level viewport. */
  dx: number;
  dy: number;
  layout: boolean;
}

/**
 * 'none': the element and everything inside it is hidden (display:none,
 * opacity 0, aria-hidden, inert…). 'invisible': only the element itself;
 * children may opt back in with `visibility: visible`.
 */
function prunedByStyle(el: Element, win: Window): 'none' | 'invisible' | false {
  if (el.hasAttribute('hidden')) return 'none';
  if (el.getAttribute('aria-hidden') === 'true') return 'none';
  if (el.hasAttribute('inert')) return 'none';
  if (el.hasAttribute(TETHER_UI_ATTRIBUTE)) return 'none';
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none') return 'none';
  if (parseFloat(cs.opacity) <= 0.05) return 'none';
  // Moved off-screen (a common way to hide content without display:none).
  if (
    (cs.position === 'absolute' || cs.position === 'fixed') &&
    (parseFloat(cs.left) <= -999 || parseFloat(cs.top) <= -999)
  ) {
    return 'none';
  }
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'invisible';
  return false;
}

const CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, [role], [onclick], [contenteditable]';

function rectIn(el: Element, ctx: FrameCtx): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + ctx.dx),
    y: Math.round(r.top + ctx.dy),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

// ---------- walk ----------

interface Found {
  el: Element;
  target?: Element;
  ctx: FrameCtx;
  rect: Rect;
}

interface WalkState {
  found: Found[];
  frames: FrameInfo[];
  frameDocs: { index: number; doc: Document }[];
  visited: number;
  pointer: number;
  topVw: number;
  topVh: number;
  nextFrame: number;
}

function visibleLabelFor(el: Element, ctx: FrameCtx): Element | undefined {
  const labels = (el as HTMLInputElement).labels;
  if (!labels) return undefined;
  for (const label of labels) {
    if (prunedByStyle(label, ctx.win)) continue;
    if (isHidden(label, ctx.win, { layout: ctx.layout })) continue;
    if (ctx.layout) {
      const r = label.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
    }
    return label;
  }
  return undefined;
}

function considerCandidate(
  el: Element,
  ctx: FrameCtx,
  st: WalkState,
  pruned: string | false,
): void {
  if (isDisabled(el)) return;
  let target: Element | undefined;
  // A visually hidden native checkbox/radio/file input with a visible label:
  // the label is what a person clicks.
  const tag = el.tagName;
  const hideable =
    tag === 'INPUT' && ['checkbox', 'radio', 'file'].includes((el as HTMLInputElement).type);
  if (pruned || isHidden(el, ctx.win, { layout: ctx.layout })) {
    if (!hideable) return;
    target = visibleLabelFor(el, ctx);
    if (!target) return;
  } else if (ctx.layout) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      if (!hideable) return;
      target = visibleLabelFor(el, ctx);
      if (!target) return;
    }
  }
  const rect = rectIn(target ?? el, ctx);
  if (ctx.layout) {
    // Within 1.5 viewport heights above or below what's on screen.
    if (rect.y > st.topVh * 2.5 || rect.y + rect.h < -st.topVh * 1.5) return;
    if (rect.x > st.topVw * 2 || rect.x + rect.w < -st.topVw) return;
  }
  st.found.push({ el, ...(target ? { target } : {}), ctx, rect });
}

function walk(root: ParentNode, ctx: FrameCtx, st: WalkState, inCandidate: boolean): void {
  for (const el of root.children) {
    if (st.visited++ > MAX_VISITED) return;
    if (SKIP_TAGS.has(el.tagName)) continue;
    const pruned = prunedByStyle(el, ctx.win);
    const candidate = isCandidate(el);
    if (candidate) {
      considerCandidate(el, ctx, st, pruned);
    } else if (
      !pruned &&
      !inCandidate &&
      st.pointer < MAX_POINTER_CANDIDATES &&
      ctx.layout &&
      el.tagName !== 'BODY' &&
      el.tagName !== 'HTML' &&
      el.tagName !== 'LABEL' &&
      ctx.win.getComputedStyle(el).cursor === 'pointer' &&
      (!el.parentElement || ctx.win.getComputedStyle(el.parentElement).cursor !== 'pointer') &&
      !el.querySelector(CONTROL_SELECTOR) &&
      visibleText(el)
    ) {
      // Clickable by styling only (div soup). Take the outermost pointer element.
      st.pointer++;
      considerCandidate(el, ctx, st, false);
    }
    if (pruned === 'none') continue;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      if (!pruned) frameInto(el as HTMLIFrameElement, ctx, st);
      continue;
    }
    if (el.tagName === 'svg' || el.tagName === 'SVG') continue;
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) walk(shadow, ctx, st, inCandidate || candidate);
    // `visibility: hidden` subtrees can contain visible children; `none` can't.
    walk(el, ctx, st, inCandidate || candidate);
  }
}

function frameInto(frame: HTMLIFrameElement, parent: FrameCtx, st: WalkState): void {
  const index = ++st.nextFrame;
  let doc: Document | null;
  try {
    doc = frame.contentDocument;
  } catch {
    // Cross-origin access can throw in some engines instead of returning null.
    doc = null;
  }
  const url = frame.src || (frame.hasAttribute('srcdoc') ? 'about:srcdoc' : 'about:blank');
  const name = frame.getAttribute('title') ?? frame.getAttribute('name') ?? undefined;
  if (!doc?.body || !frame.contentWindow) {
    st.frames.push({ index, url, opaque: true, ...(name ? { name } : {}) });
    return;
  }
  st.frames.push({
    index,
    url: doc.location.href || url,
    opaque: false,
    ...(name ? { name } : {}),
  });
  const r = frame.getBoundingClientRect();
  const ctx: FrameCtx = {
    index,
    win: frame.contentWindow,
    dx: parent.dx + r.left + frame.clientLeft,
    dy: parent.dy + r.top + frame.clientTop,
    layout: parent.layout,
  };
  st.frameDocs.push({ index, doc });
  walk(doc.body, ctx, st, false);
}

// ---------- budget ----------

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'your',
  'you',
  'what',
  'tell',
  'find',
  'page',
  'site',
  'then',
  'there',
]);

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

const FIELD_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
]);

interface Scored {
  item: SnapshotElement;
  score: number;
  line: string;
  tokens: number;
}

function priority(
  e: SnapshotElement,
  opts: {
    vw: number;
    vh: number;
    layout: boolean;
    task: Set<string>;
    last?: Rect;
    dialogOpen: boolean;
  },
): number {
  let s = 0;
  const cx = e.rect.x + e.rect.w / 2;
  const cy = e.rect.y + e.rect.h / 2;
  const diag = Math.hypot(opts.vw, opts.vh) || 1;
  if (e.inViewport) s += 100;
  if (opts.layout)
    s += 50 * (1 - Math.min(1, Math.hypot(cx - opts.vw / 2, cy - opts.vh / 2) / diag));
  if (opts.last) {
    const lx = opts.last.x + opts.last.w / 2;
    const ly = opts.last.y + opts.last.h / 2;
    s += 40 * (1 - Math.min(1, Math.hypot(cx - lx, cy - ly) / diag));
  }
  if (opts.task.size) {
    let overlap = 0;
    for (const w of words(`${e.name} ${e.hint ?? ''} ${e.value ?? ''}`))
      if (opts.task.has(w)) overlap++;
    s += Math.min(90, overlap * 30);
  }
  if (FIELD_ROLES.has(e.role)) s += 20;
  if (e.submits) s += 10;
  if (e.hint?.includes('in nav') || e.hint?.includes('in footer')) s -= 10;
  if (opts.dialogOpen) s += e.hint?.includes('in dialog') ? 1000 : -200;
  return s;
}

// ---------- rendering ----------

export function renderElement(e: SnapshotElement, pageUrl: string): string {
  let role = e.role;
  if (e.type && role === 'textbox' && !TEXT_INPUT_TYPES.has(e.type))
    role = `${role} type=${e.type}`;
  if (e.type === 'password') role = 'textbox type=password';
  if (e.tag === 'textarea') role = 'textbox multiline';
  let line = `[${e.id}] <${role}> ${JSON.stringify(e.name)}`;
  if (e.value !== undefined) line += ` value=${JSON.stringify(e.value)}`;
  if (e.state?.length) line += ` ${e.state.join(' ')}`;
  if (e.options?.length) line += ` options: ${e.options.map((o) => JSON.stringify(o)).join(' | ')}`;
  if (e.href) {
    let shown = e.href;
    try {
      const u = new URL(e.href);
      const page = new URL(pageUrl);
      if (u.origin === page.origin) shown = `${u.pathname}${u.search}${u.hash}` || '/';
    } catch {
      // keep the absolute URL
    }
    line += ` → ${shown}`;
  }
  if (e.download) line += ' (download)';
  if (e.submits) line += ' (submits form)';
  if (e.hint) line += ` — ${e.hint}`;
  return line;
}

export function renderSnapshot(s: PageSnapshot): string {
  const lines = s.elements.map((e) => renderElement(e, s.url));
  if (lines.length === 0) lines.push('(no interactive elements found)');
  if (s.dropped > 0) {
    lines.push(
      `(… ${s.dropped} more element${s.dropped === 1 ? '' : 's'} not shown; scroll or narrow down to see them)`,
    );
  }
  const opaque = s.frames.filter((f) => f.opaque);
  if (opaque.length) {
    lines.push(
      `FRAMES: ${opaque.map((f) => `[${f.index}] cross-origin ${f.url}${f.name ? ` "${f.name}"` : ''} (cannot be read)`).join('  ')}`,
    );
  }
  if (s.dialog !== undefined) {
    lines.push(
      `DIALOG OPEN: ${JSON.stringify(s.dialog || 'dialog')} — only its elements matter until it closes`,
    );
  }
  if (s.captcha) lines.push('CAPTCHA: this page shows a human-verification check');
  return lines.join('\n');
}

// ---------- page signals ----------

/** 32-bit FNV-1a, hex. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const CAPTCHA_FRAME =
  /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const CAPTCHA_TEXT =
  /verify (that )?you('| a)re (a )?human|i'?m not a robot|are you a robot|complete the (security )?(check|captcha)|prove you(’|')?re (not a robot|human)/i;

function detectCaptcha(doc: Document, frames: FrameInfo[], text: string): boolean {
  if (frames.some((f) => CAPTCHA_FRAME.test(f.url))) return true;
  if (
    doc.querySelector(
      '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #captcha, [id*="captcha" i], [class*="captcha" i]',
    )
  ) {
    return true;
  }
  return CAPTCHA_TEXT.test(text.slice(0, 20_000));
}

function openDialogName(doc: Document, win: Window, layout: boolean): string | undefined {
  const candidates = [
    ...doc.querySelectorAll(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]',
    ),
  ];
  for (const d of candidates) {
    if (prunedByStyle(d, win)) continue;
    if (layout) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
    }
    return containerName(d);
  }
  return undefined;
}

/** The open modal `<dialog>` in the top layer, if any. */
function modalDialog(doc: Document): Element | null {
  try {
    return doc.querySelector('dialog:modal');
  } catch {
    // `:modal` unsupported (older engines, jsdom).
    return null;
  }
}

// ---------- entry point ----------

export function takeSnapshot(doc: Document, win: Window, opts: SnapshotOptions = {}): PageSnapshot {
  const maxTokens = opts.maxTokens ?? 4000;
  // Typed non-null, but absent on frameset/XML documents.
  const body = doc.body as HTMLElement | null;
  const layout = (body?.getBoundingClientRect().width ?? 0) > 0;
  const vw = win.innerWidth || doc.documentElement.clientWidth || 1;
  const vh = win.innerHeight || doc.documentElement.clientHeight || 1;
  const prevLast = opts.lastId ? registry.get(opts.lastId)?.el.deref() : undefined;
  const lastRect = prevLast?.isConnected ? prevLast.getBoundingClientRect() : undefined;

  const st: WalkState = {
    found: [],
    frames: [],
    frameDocs: [],
    visited: 0,
    pointer: 0,
    topVw: vw,
    topVh: vh,
    nextFrame: 0,
  };
  const top: FrameCtx = { win, dx: 0, dy: 0, layout };
  if (body) walk(body, top, st, false);

  // Assign ids in document order (per frame for frame elements).
  const counters = new Map<number | undefined, number>();
  const next = (frame: number | undefined) => {
    const n = (counters.get(frame) ?? 0) + 1;
    counters.set(frame, n);
    return frame === undefined ? String(n) : `${frame}.${n}`;
  };

  const newRegistry = new Map<string, Entry>();
  const all: { item: SnapshotElement; entry: Entry }[] = [];
  for (const f of st.found) {
    const el = f.el;
    const role = roleOf(el);
    const id = next(f.ctx.index);
    const item: SnapshotElement = {
      id,
      tag: el.tagName.toLowerCase(),
      role,
      name: accessibleName(el),
      inViewport:
        !layout ||
        (f.rect.y < vh && f.rect.y + f.rect.h > 0 && f.rect.x < vw && f.rect.x + f.rect.w > 0),
      rect: f.rect,
    };
    const value = valueOf(el);
    if (value !== undefined) item.value = value;
    const state = stateOf(el, role);
    if (state.length) item.state = state;
    if (el.tagName === 'INPUT') item.type = (el as HTMLInputElement).type.toLowerCase();
    const ac = el.getAttribute('autocomplete');
    if (ac) item.autocomplete = ac;
    const hint = hintOf(el, f.ctx.index);
    if (hint) item.hint = hint;
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      try {
        item.href = new URL(el.getAttribute('href') ?? '', el.ownerDocument.baseURI).href;
      } catch {
        // unparseable href: leave it out
      }
      if (el.hasAttribute('download')) item.download = true;
    }
    const options = optionsOf(el);
    if (options) item.options = options;
    const formOwner = (el as HTMLButtonElement).form ?? null;
    if (formOwner || closestAcrossShadow(el, 'form')) item.inForm = true;
    if (formOwner) {
      const t =
        el.tagName === 'BUTTON'
          ? ((el as HTMLButtonElement).getAttribute('type') ?? 'submit').toLowerCase()
          : el.tagName === 'INPUT'
            ? (el as HTMLInputElement).type.toLowerCase()
            : '';
      if (t === 'submit' || t === 'image') item.submits = true;
    }
    all.push({
      item,
      entry: { el: new WeakRef(el), ...(f.target ? { target: new WeakRef(f.target) } : {}) },
    });
  }

  const dialog = openDialogName(doc, win, layout);
  // A modal dialog (showModal) makes the rest of the page inert: nothing
  // outside it can be clicked, so it isn't listed (ids stay resolvable).
  const modal = modalDialog(doc);
  const listed = modal
    ? all.filter(({ entry }) => {
        const el = entry.el.deref();
        return !!el && closestAcrossShadow(el, 'dialog') === modal;
      })
    : all;
  const taskWords = words(opts.task ?? '');
  const pageUrl = (doc.location as Location | null)?.href ?? '';
  const scored: Scored[] = listed.map(({ item }) => {
    const line = renderElement(item, pageUrl);
    return {
      item,
      line,
      tokens: estimateTokens(line) + 1,
      score: priority(item, {
        vw,
        vh,
        layout,
        task: taskWords,
        ...(lastRect
          ? { last: { x: lastRect.left, y: lastRect.top, w: lastRect.width, h: lastRect.height } }
          : {}),
        dialogOpen: dialog !== undefined,
      }),
    };
  });
  let total = scored.reduce((n, s) => n + s.tokens, 0);
  const dropped = new Set<SnapshotElement>();
  if (total > maxTokens) {
    for (const s of [...scored].sort((a, b) => a.score - b.score)) {
      if (total <= maxTokens) break;
      dropped.add(s.item);
      total -= s.tokens;
    }
  }

  // Every id stays resolvable (the model may act on one it saw before the
  // budget cut); only the listing is trimmed.
  for (const { item, entry } of all) newRegistry.set(item.id, entry);
  registry = newRegistry;

  const extract = extractPage(doc, win, { maxChars: opts.maxTextChars ?? 6000 });
  const elements = listed.map((a) => a.item).filter((e) => !dropped.has(e));
  const captcha = detectCaptcha(doc, st.frames, extract.text);
  const hashInput = [
    pageUrl,
    ...all.map(
      ({ item }) => `${item.role}|${item.name}|${item.value ?? ''}|${(item.state ?? []).join(',')}`,
    ),
    String(extract.text.length),
    extract.text.slice(0, 2000),
  ].join('\n');

  const snapshot: PageSnapshot = {
    url: pageUrl,
    title: doc.title,
    elements,
    dropped: dropped.size,
    frames: st.frames,
    text: extract.text,
    links: extract.links,
    scroll: {
      y: Math.round(win.scrollY),
      height: Math.round(doc.documentElement.scrollHeight),
      viewport: Math.round(vh),
    },
    hash: fnv1a(hashInput),
    captcha,
  };
  if (dialog !== undefined) snapshot.dialog = dialog;
  return snapshot;
}
