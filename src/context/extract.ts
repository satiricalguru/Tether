import { Readability } from '@mozilla/readability';

/**
 * Page → compact text for the model. Runs inside the page (content script).
 *
 *  1. Clone the DOM keeping only what a person can see. Hidden text is the
 *     classic prompt-injection channel, so it never reaches the model; it is
 *     kept aside (capped) only to warn about it.
 *  2. Find the main content with Readability; fall back to landmarks.
 *  3. Serialize to Markdown-ish text: structure survives, markup doesn't.
 */

export type ExtractMethod = 'readability' | 'main' | 'body';

export interface PageExtract {
  url: string;
  title: string;
  lang?: string;
  byline?: string;
  siteName?: string;
  text: string;
  selection: string;
  method: ExtractMethod;
  truncated: boolean;
  /** Characters of hidden text left out. */
  hiddenChars: number;
  /** Hidden text, capped, for the injection scanner (never sent to the model). */
  hiddenSample: string;
  /** Visible links (absolute http(s) URLs), in page order, for the agent. */
  links: PageLink[];
}

export interface PageLink {
  text: string;
  url: string;
}

export const MAX_LINKS = 40;

/**
 * Links a person can see, from the visibility-filtered clone: absolute
 * http(s) only, deduplicated by URL, labelled by their text (or aria-label /
 * title), capped. The agent reads these instead of guessing URLs.
 */
export function collectLinks(root: Element, base: string, max = MAX_LINKS): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const a of root.querySelectorAll('a[href]')) {
    let url: URL;
    try {
      url = new URL(a.getAttribute('href') ?? '', base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const key = url.href;
    // First non-empty of: visible text, aria-label, title.
    const label = (
      [
        a.textContent.replace(/\s+/g, ' ').trim(),
        a.getAttribute('aria-label'),
        a.getAttribute('title'),
      ].find((t) => t?.trim()) ?? ''
    ).slice(0, 80);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: label, url: key });
    if (out.length >= max) break;
  }
  return out;
}

export interface ExtractOptions {
  maxChars?: number;
  /** Stop computing styles after this many elements (huge pages). */
  maxStyledElements?: number;
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'CANVAS',
  'SVG',
  'VIDEO',
  'AUDIO',
  'SELECT',
  'OPTION',
  'BUTTON',
  'INPUT',
  'TEXTAREA',
]);

/** Tether's own UI (highlight bubble host) must never be read as page content. */
const OWN_UI_ATTR = 'data-tether-ui';

function parseRgb(color: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(color);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [parseFloat(m[1] ?? '0'), parseFloat(m[2] ?? '0'), parseFloat(m[3] ?? '0'), a];
}

/** First opaque background behind `el`, defaulting to white. */
function effectiveBackground(el: Element, win: Window): [number, number, number] {
  let cur: Element | null = el;
  while (cur) {
    const bg = parseRgb(win.getComputedStyle(cur).backgroundColor);
    if (bg && bg[3] > 0.9) return [bg[0], bg[1], bg[2]];
    cur = cur.parentElement;
  }
  return [255, 255, 255];
}

function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && (n.textContent ?? '').trim()) return true;
  }
  return false;
}

export interface HiddenCheck {
  layout: boolean;
}

/** Would a person see this element? Inherited hiding is handled by the walk. */
export function isHidden(el: Element, win: Window, ctx: HiddenCheck): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute(OWN_UI_ATTR)) return true;
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none') return true;
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
  if (parseFloat(cs.opacity) <= 0.05) return true;
  const fontSize = parseFloat(cs.fontSize);
  if (Number.isFinite(fontSize) && fontSize < 2 && hasOwnText(el)) return true;
  // Chrome reports "rect(0px, 0px, 0px, 0px)"; other engines may collapse it.
  if (/^rect\(\s*0(px)?(\s*[,\s]\s*0(px)?){0,3}\s*\)$/.test(cs.getPropertyValue('clip')))
    return true;
  // The classic visually-hidden pattern, detectable without layout.
  if (
    cs.overflow === 'hidden' &&
    (parseFloat(cs.width) <= 1 || parseFloat(cs.height) <= 1) &&
    (cs.position === 'absolute' || cs.position === 'fixed')
  ) {
    return true;
  }
  if (/inset\(\s*(50|100)%/.test(cs.clipPath)) return true;
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    const left = parseFloat(cs.left);
    const top = parseFloat(cs.top);
    if (left <= -999 || top <= -999) return true;
  }
  if (parseFloat(cs.textIndent) <= -999) return true;
  if (ctx.layout && el !== el.ownerDocument.body) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.getClientRects().length === 0) return true;
    if ((r.width <= 1 || r.height <= 1) && cs.overflow === 'hidden') return true;
    const vw = win.innerWidth || 1;
    if (r.right < -vw || r.left > vw * 4 || r.bottom < -5000) return true;
  }
  if (hasOwnText(el)) {
    const fg = parseRgb(cs.color);
    if (fg && fg[3] < 0.1) return true;
    if (fg) {
      const bg = effectiveBackground(el, win);
      const d = Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]);
      if (d < 24) return true;
    }
  }
  return false;
}

interface CloneState {
  styled: number;
  maxStyled: number;
  hidden: string[];
  hiddenChars: number;
  ctx: HiddenCheck;
}

const HIDDEN_SAMPLE_CAP = 20_000;

function cloneVisible(node: Node, win: Window, into: Document, st: CloneState): Node | null {
  if (node.nodeType === 3) return into.createTextNode(node.textContent ?? '');
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return null;
  if (st.styled < st.maxStyled) {
    st.styled++;
    if (isHidden(el, win, st.ctx)) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t) {
        st.hiddenChars += t.length;
        if (st.hidden.join(' ').length < HIDDEN_SAMPLE_CAP) st.hidden.push(t.slice(0, 2000));
      }
      return null;
    }
  }
  const copy = into.importNode(el, false);
  // Inline handlers and styles are irrelevant and shouldn't survive into the clone.
  for (const attr of [...copy.attributes]) {
    if (attr.name.startsWith('on') || attr.name === 'style') copy.removeAttribute(attr.name);
  }
  // Open shadow roots hold real content on component-heavy sites.
  const children = el.shadowRoot
    ? [...el.shadowRoot.childNodes, ...el.childNodes]
    : [...el.childNodes];
  for (const child of children) {
    const c = cloneVisible(child, win, into, st);
    if (c) copy.appendChild(c);
  }
  return copy;
}

// ---------- serialization ----------

const BLOCK = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'SECTION',
  'TABLE',
  'UL',
  'DETAILS',
  'SUMMARY',
  'BODY',
]);

function inlineText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt')?.trim();
    return alt ? `[image: ${alt}]` : '';
  }
  const inner = [...el.childNodes].map(inlineText).join('');
  if (tag === 'CODE') return inner.trim() ? `\`${inner.trim()}\`` : '';
  if (tag === 'STRONG' || tag === 'B') return inner.trim() ? `**${inner.trim()}**` : '';
  return inner;
}

function collapse(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serialize(el: Element, out: string[], depth = 0): void {
  const tag = el.tagName.toUpperCase();
  const push = (s: string) => {
    const t = collapse(s);
    if (t) out.push(t);
  };
  const h = /^H([1-6])$/.exec(tag);
  if (h) {
    push(`${'#'.repeat(Number(h[1]))} ${inlineText(el).replace(/\s+/g, ' ')}`);
    return;
  }
  switch (tag) {
    case 'PRE':
      out.push(`\`\`\`\n${el.textContent.replace(/\n+$/, '')}\n\`\`\``);
      return;
    case 'UL':
    case 'OL': {
      let i = Number(el.getAttribute('start') ?? '1');
      const lines: string[] = [];
      for (const li of el.children) {
        if (li.tagName.toUpperCase() !== 'LI') continue;
        const nested: string[] = [];
        const own: Node[] = [];
        for (const c of li.childNodes) {
          if (c.nodeType === 1 && ['UL', 'OL'].includes((c as Element).tagName.toUpperCase())) {
            serialize(c as Element, nested, depth + 1);
          } else own.push(c);
        }
        const text = collapse(own.map(inlineText).join('')).replace(/\n+/g, ' ');
        const bullet = tag === 'OL' ? `${i++}.` : '-';
        if (text) lines.push(`${'  '.repeat(depth)}${bullet} ${text}`);
        lines.push(...nested);
      }
      if (lines.length) out.push(lines.join('\n'));
      return;
    }
    case 'TABLE': {
      const rows: string[] = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.children]
          .filter((c) => ['TD', 'TH'].includes(c.tagName.toUpperCase()))
          .map((c) => collapse(inlineText(c)).replace(/\s+/g, ' '));
        if (cells.some(Boolean)) rows.push(`| ${cells.join(' | ')} |`);
      }
      if (rows.length) out.push(rows.join('\n'));
      return;
    }
    case 'BLOCKQUOTE': {
      const inner: string[] = [];
      for (const c of el.children) serialize(c, inner, depth);
      const text = inner.length ? inner.join('\n\n') : collapse(inlineText(el));
      if (text)
        out.push(
          text
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
      return;
    }
    case 'HR':
      out.push('---');
      return;
  }
  // Mixed content: gather inline runs between block children.
  let run = '';
  const flush = () => {
    push(run);
    run = '';
  };
  for (const c of el.childNodes) {
    if (c.nodeType === 1) {
      const ct = (c as Element).tagName.toUpperCase();
      if (BLOCK.has(ct) || /^H[1-6]$/.test(ct) || ['PRE', 'BLOCKQUOTE', 'TABLE'].includes(ct)) {
        flush();
        serialize(c as Element, out, depth);
        continue;
      }
    }
    run += inlineText(c);
  }
  flush();
}

export function toText(root: Element): string {
  const out: string[] = [];
  serialize(root, out);
  return out.join('\n\n');
}

// ---------- entry point ----------

function fallbackRoot(doc: Document): { el: Element; method: ExtractMethod } {
  const main = doc.querySelector('main, [role="main"]') ?? doc.querySelector('article');
  if (main && main.textContent.trim().length > 200) return { el: main, method: 'main' };
  return { el: doc.body, method: 'body' };
}

export function extractPage(doc: Document, win: Window, opts: ExtractOptions = {}): PageExtract {
  // Typed non-null, but absent on frameset pages and parsed documents.
  const docBody = doc.body as HTMLElement | null;
  const docLocation = doc.location as Location | null;
  const maxChars = opts.maxChars ?? 400_000;
  const scratch = doc.implementation.createHTMLDocument(doc.title);
  const st: CloneState = {
    styled: 0,
    maxStyled: opts.maxStyledElements ?? 25_000,
    hidden: [],
    hiddenChars: 0,
    ctx: { layout: (docBody?.getBoundingClientRect().width ?? 0) > 0 },
  };
  const body = docBody ? cloneVisible(docBody, win, scratch, st) : null;
  if (body) scratch.body.replaceWith(body);
  const links = collectLinks(scratch.body, docLocation?.href ?? doc.baseURI);

  let text = '';
  let method: ExtractMethod = 'body';
  let byline: string | undefined;
  let siteName: string | undefined;
  let title = doc.title;

  try {
    const article = new Readability(scratch.cloneNode(true) as Document, {
      charThreshold: 300,
    }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= 300) {
      // DOMParser documents are inert: page scripts can't run here.
      const parsed = new DOMParser().parseFromString(article.content, 'text/html');
      text = toText(parsed.body);
      method = 'readability';
      byline = article.byline ?? undefined;
      siteName = article.siteName ?? undefined;
      if (article.title) title = article.title;
    }
  } catch {
    // Readability can throw on exotic DOMs; fall back below.
  }
  if (!text) {
    const fb = fallbackRoot(scratch);
    text = toText(fb.el);
    method = fb.method;
  }

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  const selection = (win.getSelection()?.toString() ?? '').trim().slice(0, 50_000);

  const out: PageExtract = {
    url: docLocation?.href ?? '',
    title: title.trim(),
    text,
    selection,
    method,
    truncated,
    hiddenChars: st.hiddenChars,
    hiddenSample: st.hidden.join('\n').slice(0, HIDDEN_SAMPLE_CAP),
    links,
  };
  const lang = doc.documentElement.getAttribute('lang');
  if (lang) out.lang = lang;
  if (byline) out.byline = byline;
  if (siteName) out.siteName = siteName;
  return out;
}

export const TETHER_UI_ATTRIBUTE = OWN_UI_ATTR;
