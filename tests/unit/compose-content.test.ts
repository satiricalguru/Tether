import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposeRequest } from '@/compose/prompt';

const opened: ComposeRequest[] = [];
let reply = 'Could you send it today?';

vi.mock('@/lib/ports', () => ({
  openStream: (_name: string, req: ComposeRequest) => {
    opened.push(req);
    const chunks = [
      { type: 'status', status: 'generating' },
      { type: 'text', text: reply.slice(0, 6) },
      { type: 'text', text: reply.slice(6) },
    ];
    return {
      done: Promise.resolve({}),
      abort: () => undefined,
      send: () => undefined,
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) {
          await Promise.resolve();
          yield c;
        }
      },
    };
  },
}));

const { applyText, captureTarget, composeTarget, installCompose, isComposeShortcut } =
  await import('@/content/compose');

beforeEach(() => {
  opened.length = 0;
  reply = 'Could you send it today?';
});
afterEach(() => {
  document.body.innerHTML = '';
  document.querySelectorAll('tether-compose').forEach((e) => {
    e.remove();
  });
});

const $ = (sel: string) => document.querySelector(sel)!;

describe('which fields compose may edit', () => {
  it('takes text inputs, textareas and contenteditable', () => {
    document.body.innerHTML = `
      <input id="t" type="text"><input id="e" type="email"><textarea id="a"></textarea>
      <div id="ce" contenteditable="true"><p id="inner">x</p></div>`;
    expect(composeTarget($('#t'))).toBe($('#t'));
    expect(composeTarget($('#e'))).toBe($('#e'));
    expect(composeTarget($('#a'))).toBe($('#a'));
    // The editing host, not the paragraph the caret is in.
    expect(composeTarget($('#inner'))).toBe($('#ce'));
  });

  it('refuses secrets, non-text and read-only fields', () => {
    document.body.innerHTML = `
      <input id="pw" type="password"><input id="otp" autocomplete="one-time-code">
      <input id="cc" autocomplete="cc-number"><input id="pin" name="pin">
      <input id="card" aria-label="Card number"><input id="n" type="number">
      <input id="cb" type="checkbox"><textarea id="ro" readonly></textarea>
      <input id="dis" disabled><button id="b">x</button>`;
    for (const id of ['pw', 'otp', 'cc', 'pin', 'card', 'n', 'cb', 'ro', 'dis', 'b']) {
      expect(composeTarget($(`#${id}`)), id).toBeNull();
    }
  });
});

describe('applying text', () => {
  it('replaces the selection in a textarea and fires input', () => {
    document.body.innerHTML = '<textarea>hi can u send it</textarea>';
    const ta = $('textarea') as HTMLTextAreaElement;
    ta.setSelectionRange(7, 13);
    const t = captureTarget(ta);
    expect(t.text).toBe('u send');
    expect(t.selection).toBe(true);
    const events: string[] = [];
    ta.addEventListener('input', () => events.push('input'));
    ta.addEventListener('change', () => events.push('change'));
    expect(applyText(t, 'you send')).toEqual({ ok: true });
    expect(ta.value).toBe('hi can you send it');
    expect(events).toEqual(['input', 'change']);
  });

  it('replaces the whole value with nothing selected, through the native setter', () => {
    document.body.innerHTML = '<input value="draft">';
    const input = $('input') as HTMLInputElement;
    // What React does: an own `value` property that hides the prototype setter.
    let tracked = 'draft';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => tracked,
      set: (v: string) => {
        tracked = v;
      },
    });
    input.setSelectionRange(5, 5);
    const t = captureTarget(input);
    expect(t.selection).toBe(false);
    applyText(t, 'final');
    // The prototype setter ran (React's tracker would see the change).
    delete (input as { value?: string }).value;
    expect(input.value).toBe('final');
  });

  it('refuses when the field changed meanwhile', () => {
    document.body.innerHTML = '<textarea>one</textarea>';
    const ta = $('textarea') as HTMLTextAreaElement;
    const t = captureTarget(ta);
    ta.value = 'one two';
    expect(applyText(t, 'x')).toMatchObject({ ok: false });
    expect(ta.value).toBe('one two');
  });

  it('replaces a contenteditable, keeping line breaks', () => {
    document.body.innerHTML = '<div contenteditable="true">old text</div>';
    const div = $('div') as HTMLDivElement;
    const t = captureTarget(div);
    expect(t.text).toBe('old text');
    applyText(t, 'line one\nline two');
    expect(div.innerHTML).toBe('line one<br>line two');
  });

  it('replaces only the selected part of a contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true">keep this, change that</div>';
    const div = $('div') as HTMLDivElement;
    const text = div.firstChild!;
    const range = document.createRange();
    range.setStart(text, 11);
    range.setEnd(text, 22);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const t = captureTarget(div);
    expect(t.text).toBe('change that');
    applyText(t, 'swap it');
    expect(div.textContent).toBe('keep this, swap it');
  });
});

describe('shortcut', () => {
  const k = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'k', ...init });
  it('is Cmd+K on macOS and Ctrl+K elsewhere, with nothing else held', () => {
    expect(isComposeShortcut(k({ metaKey: true }), true)).toBe(true);
    expect(isComposeShortcut(k({ ctrlKey: true }), true)).toBe(false);
    expect(isComposeShortcut(k({ ctrlKey: true }), false)).toBe(true);
    expect(isComposeShortcut(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isComposeShortcut(k({ key: 'j', ctrlKey: true }), false)).toBe(false);
  });
});

describe('popover', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('previews a rewrite as a diff and applies it on Accept', async () => {
    document.body.innerHTML = '<textarea>hi can u send it</textarea>';
    const ta = $('textarea') as HTMLTextAreaElement;
    const c = installCompose({ enabled: () => true, shadowMode: 'open' });
    expect(c.openFor(ta)).toBe(true);
    const host = $('tether-compose') as HTMLElement;
    const root = host.shadowRoot!;
    expect(host.dataset.state).toBe('open');
    expect(root.activeElement?.getAttribute('aria-label')).toBe('Instruction');

    root.querySelector<HTMLButtonElement>('[data-mode="rewrite"]')!.click();
    await settle();
    expect(opened[0]).toMatchObject({ mode: 'rewrite', text: 'hi can u send it' });
    expect(host.dataset.state).toBe('ready');
    expect(root.querySelector('del')?.textContent).toBeTruthy();
    expect([...root.querySelectorAll('ins')].map((e) => e.textContent).join('|')).toContain(
      'today',
    );
    // Nothing changed until Accept, which has focus.
    expect(ta.value).toBe('hi can u send it');
    const accept = root.activeElement as HTMLButtonElement;
    expect(accept.textContent).toBe('Accept');
    accept.click();
    expect(ta.value).toBe('Could you send it today?');
    expect(host.dataset.state).toBe('closed');
    c.dispose();
  });

  it('Reject and Esc leave the field untouched', async () => {
    document.body.innerHTML = '<textarea>original</textarea>';
    const ta = $('textarea') as HTMLTextAreaElement;
    const c = installCompose({ enabled: () => true, shadowMode: 'open' });
    c.openFor(ta);
    const root = ($('tether-compose') as HTMLElement).shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-mode="shorten"]')!.click();
    await settle();
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Reject')!.click();
    expect(ta.value).toBe('original');

    c.openFor(ta);
    root
      .querySelector('.wrap')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(($('tether-compose') as HTMLElement).dataset.state).toBe('closed');
    expect(ta.value).toBe('original');
    c.dispose();
  });

  it('writes into an empty field from a free prompt', async () => {
    reply = 'Thanks, but I can’t make it.';
    document.body.innerHTML = '<textarea></textarea>';
    const ta = $('textarea') as HTMLTextAreaElement;
    const c = installCompose({ enabled: () => true, shadowMode: 'open' });
    c.openFor(ta);
    const root = ($('tether-compose') as HTMLElement).shadowRoot!;
    expect(root.querySelector('[data-mode]')).toBeNull();
    const input = root.querySelector('input')!;
    input.value = 'a polite decline';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(opened[0]).toMatchObject({ mode: 'prompt', instruction: 'a polite decline', text: '' });
    (root.activeElement as HTMLButtonElement).click();
    expect(ta.value).toBe('Thanks, but I can’t make it.');
    c.dispose();
  });

  it('does not open on a password field', () => {
    document.body.innerHTML = '<input type="password">';
    const c = installCompose({ enabled: () => true, shadowMode: 'open' });
    expect(c.openFor($('input'))).toBe(false);
    expect(document.querySelector('tether-compose')).toBeNull();
    c.dispose();
  });
});
