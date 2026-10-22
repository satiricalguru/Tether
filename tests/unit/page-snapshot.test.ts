import { afterEach, describe, expect, it } from 'vitest';
import {
  accessibleName,
  renderSnapshot,
  resolveElement,
  resolveTarget,
  takeSnapshot,
} from '@/agent/page/snapshot';
import type { PageSnapshot, SnapshotElement } from '@/agent/page/types';

function page(html: string): PageSnapshot {
  document.body.innerHTML = html;
  return takeSnapshot(document, window);
}

const byName = (s: PageSnapshot, name: string): SnapshotElement | undefined =>
  s.elements.find((e) => e.name === name);

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('takeSnapshot: what counts as interactive', () => {
  it('finds links, buttons, fields, selects, ARIA widgets, summary, contenteditable and onclick', () => {
    const s = page(`
      <a href="/a">Docs</a>
      <a>no href</a>
      <button>Save</button>
      <input type="hidden" name="csrf" value="x">
      <input aria-label="Email" type="email">
      <select aria-label="Size"><option>S</option><option selected>M</option></select>
      <textarea aria-label="Notes"></textarea>
      <div role="tab" aria-selected="true">Overview</div>
      <details><summary>More</summary><p>x</p></details>
      <div contenteditable="true" aria-label="Editor"><p>hello</p></div>
      <div onclick="void 0">Clickable div</div>
    `);
    expect(s.elements.map((e) => [e.role, e.name])).toEqual([
      ['link', 'Docs'],
      ['button', 'Save'],
      ['textbox', 'Email'],
      ['combobox', 'Size'],
      ['textbox', 'Notes'],
      ['tab', 'Overview'],
      ['button', 'More'],
      ['textbox', 'Editor'],
      ['clickable', 'Clickable div'],
    ]);
    expect(s.elements.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('leaves out hidden, aria-hidden, inert, disabled and Tether’s own UI', () => {
    const s = page(`
      <button>Visible</button>
      <button style="display:none">Gone</button>
      <div style="opacity:0"><button>Faded</button></div>
      <div aria-hidden="true"><button>Aria hidden</button></div>
      <div inert><button>Inert</button></div>
      <button disabled>Disabled</button>
      <button aria-disabled="true">Aria disabled</button>
      <fieldset disabled><input aria-label="In disabled fieldset"></fieldset>
      <div data-tether-ui><button>Explain</button></div>
      <button hidden>Hidden attr</button>
      <span style="position:absolute;left:-10000px"><button>Offscreen</button></span>
    `);
    expect(s.elements.map((e) => e.name)).toEqual(['Visible']);
  });

  it('lets visibility:visible children of a visibility:hidden parent through', () => {
    const s = page(
      `<div style="visibility:hidden"><button style="visibility:visible">Shown</button><button>Not shown</button></div>`,
    );
    expect(s.elements.map((e) => e.name)).toEqual(['Shown']);
  });

  it('pierces open shadow roots', () => {
    document.body.innerHTML = '<x-widget></x-widget>';
    const host = document.querySelector('x-widget')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="q">Query</label><input id="q"><button>Go</button>';
    const s = takeSnapshot(document, window);
    expect(s.elements.map((e) => [e.role, e.name])).toEqual([
      ['textbox', 'Query'],
      ['button', 'Go'],
    ]);
    expect(resolveElement('2')).toBe(root.querySelector('button'));
  });

  it('walks same-origin frames with prefixed ids and lists them', () => {
    document.body.innerHTML =
      '<button>Top</button><iframe title="Payment"></iframe><button>After</button>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<input aria-label="Card name"><button>Pay</button>';
    const s = takeSnapshot(document, window);
    expect(s.elements.map((e) => [e.id, e.name, e.hint])).toEqual([
      ['1', 'Top', undefined],
      ['1.1', 'Card name', 'in frame 1'],
      ['1.2', 'Pay', 'in frame 1'],
      ['2', 'After', undefined],
    ]);
    expect(s.frames).toEqual([
      expect.objectContaining({ index: 1, opaque: false, name: 'Payment' }),
    ]);
    expect(resolveElement('1.2')?.textContent).toBe('Pay');
  });
});

describe('names, values and state', () => {
  it('follows the accessible-name order', () => {
    document.body.innerHTML = `
      <span id="lbl">Labelled by</span>
      <input id="a" aria-labelledby="lbl" aria-label="ignored">
      <input id="b" aria-label="Aria label" placeholder="ignored">
      <label for="c">For label</label><input id="c" placeholder="ignored">
      <label>Wrapping <input id="d"></label>
      <input id="e" placeholder="Placeholder only">
      <input id="f" type="submit" value="Send it">
      <input id="g" type="submit">
      <button id="h" title="ignored">Text wins</button>
      <button id="i" title="Title fallback"></button>
      <a id="j" href="/"><img alt="Home logo"></a>
      <h3>Shipping</h3><div><input id="k"></div>`;
    const name = (id: string) => accessibleName(document.getElementById(id)!);
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map(name)).toEqual([
      'Labelled by',
      'Aria label',
      'For label',
      'Wrapping',
      'Placeholder only',
      'Send it',
      'Submit',
      'Text wins',
      'Title fallback',
      'Home logo',
      'near: Shipping',
    ]);
  });

  it('reports values but never a password', () => {
    const s = page(`
      <input aria-label="Search" value="laptop">
      <input aria-label="Password" type="password" value="hunter2">
      <input aria-label="Empty password" type="password">
      <input aria-label="Card" autocomplete="cc-number" value="4242424242424242">
      <select aria-label="Size"><option>S</option><option selected>Large</option></select>`);
    expect(byName(s, 'Search')?.value).toBe('laptop');
    expect(byName(s, 'Password')?.value).toBe('••••');
    expect(byName(s, 'Empty password')?.value).toBeUndefined();
    expect(byName(s, 'Card')?.value).toBe('••••');
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect(JSON.stringify(s)).not.toContain('4242424242424242');
    expect(byName(s, 'Size')).toMatchObject({ value: 'Large', options: ['S', 'Large'] });
  });

  it('reports checked, expanded, selected, required and readonly', () => {
    const s = page(`
      <input type="checkbox" aria-label="In stock only">
      <input type="checkbox" aria-label="Gift" checked>
      <div role="switch" aria-checked="true" aria-label="Dark mode"></div>
      <button aria-expanded="false">Menu</button>
      <input aria-label="Name" required readonly>`);
    expect(s.elements.map((e) => [e.name, e.state])).toEqual([
      ['In stock only', ['unchecked']],
      ['Gift', ['checked']],
      ['Dark mode', ['checked']],
      ['Menu', ['collapsed']],
      ['Name', ['required', 'readonly']],
    ]);
  });

  it('adds form/dialog/nav hints, submit and link details', () => {
    const s = page(`
      <nav><a href="/about">About</a></nav>
      <form aria-label="Checkout"><input aria-label="Zip"><button>Place order</button><button type="button">Back</button></form>
      <div role="dialog" aria-label="Sign in"><button>Close</button></div>
      <a href="/report.pdf" download>Report</a>`);
    expect(byName(s, 'About')).toMatchObject({
      hint: 'in nav',
      href: 'http://localhost:3000/about',
    });
    expect(byName(s, 'Zip')).toMatchObject({ hint: 'in form "Checkout"', inForm: true });
    expect(byName(s, 'Place order')).toMatchObject({ submits: true });
    expect(byName(s, 'Back')?.submits).toBeUndefined();
    expect(byName(s, 'Close')?.hint).toBe('in dialog "Sign in"');
    expect(byName(s, 'Report')?.download).toBe(true);
  });

  it('uses a visible label to stand in for a visually hidden checkbox', () => {
    const s = page(`
      <input type="checkbox" id="t" style="opacity:0;position:absolute">
      <label for="t">Accept terms</label>`);
    const cb = s.elements.find((e) => e.role === 'checkbox');
    expect(cb).toMatchObject({ name: 'Accept terms', state: ['unchecked'] });
    expect(resolveElement(cb!.id)?.tagName).toBe('INPUT');
    expect(resolveTarget(cb!.id)?.tagName).toBe('LABEL');
  });
});

describe('budget, hash, captcha, dialog', () => {
  it('drops the lowest-priority elements first and keeps task-relevant ones', () => {
    const buttons = Array.from({ length: 150 }, (_, i) => `<button>Item number ${i}</button>`).join(
      '',
    );
    document.body.innerHTML = `${buttons}<form aria-label="Newsletter"><input aria-label="Subscribe email"></form>`;
    const s = takeSnapshot(document, window, {
      maxTokens: 300,
      task: 'subscribe to the newsletter',
    });
    expect(s.dropped).toBeGreaterThan(100);
    expect(s.elements.length + s.dropped).toBe(151);
    expect(s.elements.map((e) => e.name)).toContain('Subscribe email');
    // Dropped elements stay resolvable.
    expect(resolveElement('150')).toBeDefined();
  });

  it('keeps an open dialog’s elements ahead of the page behind it', () => {
    const behind = Array.from(
      { length: 100 },
      (_, i) => `<a href="/p${i}">Page link ${i}</a>`,
    ).join('');
    document.body.innerHTML = `${behind}<dialog open aria-label="Cookies"><button>Accept all</button><button>Reject all</button></dialog>`;
    const s = takeSnapshot(document, window, { maxTokens: 120 });
    expect(s.dialog).toBe('Cookies');
    expect(s.elements.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Accept all', 'Reject all']),
    );
    expect(renderSnapshot(s)).toContain(
      'DIALOG OPEN: "Cookies" — only its elements matter until it closes',
    );
  });

  it('hash changes with values and content, not with irrelevant attributes', () => {
    document.body.innerHTML = '<main><p>Results</p><input aria-label="Q"></main>';
    const a = takeSnapshot(document, window).hash;
    document.querySelector('main')!.setAttribute('class', 'fancy');
    expect(takeSnapshot(document, window).hash).toBe(a);
    document.querySelector('input')!.value = 'boots';
    const b = takeSnapshot(document, window).hash;
    expect(b).not.toBe(a);
    document.querySelector('p')!.textContent = 'Results: 3 boots';
    expect(takeSnapshot(document, window).hash).not.toBe(b);
  });

  it('detects CAPTCHAs', () => {
    expect(page('<div class="g-recaptcha" data-sitekey="x"></div>').captcha).toBe(true);
    expect(page('<main><h1>Verify you are human</h1><p>Please wait…</p></main>').captcha).toBe(
      true,
    );
    expect(page('<iframe src="https://challenges.cloudflare.com/x"></iframe>').captcha).toBe(true);
    expect(page('<button>Normal page</button>').captcha).toBe(false);
  });
});

describe('renderSnapshot', () => {
  it('renders the spec’s line format', () => {
    document.title = 'Search';
    document.body.innerHTML = `
      <form aria-label="Filters">
        <input aria-label="Search" value="laptop">
        <button>Search</button>
        <input type="checkbox" aria-label="In stock only">
        <input type="password" aria-label="Pin">
        <textarea aria-label="Comment"></textarea>
        <select aria-label="Sort"><option>Price</option><option>Rating</option></select>
      </form>
      <a href="/p/xps">Dell XPS 13 — $899</a>
      <a href="https://other.example/x">Elsewhere</a>`;
    const s = takeSnapshot(document, window);
    expect(renderSnapshot(s)).toBe(
      [
        '[1] <textbox> "Search" value="laptop" — in form "Filters"',
        '[2] <button> "Search" (submits form) — in form "Filters"',
        '[3] <checkbox> "In stock only" unchecked — in form "Filters"',
        '[4] <textbox type=password> "Pin" — in form "Filters"',
        '[5] <textbox multiline> "Comment" — in form "Filters"',
        '[6] <combobox> "Sort" value="Price" options: "Price" | "Rating" — in form "Filters"',
        '[7] <link> "Dell XPS 13 — $899" → /p/xps',
        '[8] <link> "Elsewhere" → https://other.example/x',
      ].join('\n'),
    );
  });

  it('notes dropped elements and opaque frames', () => {
    const s: PageSnapshot = {
      url: 'https://a.test/',
      title: '',
      elements: [],
      dropped: 37,
      frames: [{ index: 2, url: 'https://ads.example/frame', opaque: true }],
      text: '',
      links: [],
      scroll: { y: 0, height: 0, viewport: 0 },
      hash: 'x',
      captcha: false,
    };
    expect(renderSnapshot(s)).toBe(
      [
        '(no interactive elements found)',
        '(… 37 more elements not shown; scroll or narrow down to see them)',
        'FRAMES: [2] cross-origin https://ads.example/frame (cannot be read)',
      ].join('\n'),
    );
  });
});
