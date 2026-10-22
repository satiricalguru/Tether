import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseKey, performAction, setNativeValue } from '@/agent/page/actions';
import { takeSnapshot } from '@/agent/page/snapshot';

function setup(html: string) {
  document.body.innerHTML = html;
  const snap = takeSnapshot(document, window);
  const id = (name: string) => {
    const e = snap.elements.find((x) => x.name === name);
    if (!e)
      throw new Error(`no element "${name}" in ${snap.elements.map((x) => x.name).join(', ')}`);
    return e.id;
  };
  return { snap, id };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('click', () => {
  it('dispatches a realistic pointer + mouse sequence, focusing the element', async () => {
    const { id } = setup('<button>Go</button>');
    const btn = document.querySelector('button')!;
    const seen: string[] = [];
    for (const t of [
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
      'pointerdown',
      'mousedown',
      'focus',
      'pointerup',
      'mouseup',
      'click',
    ]) {
      btn.addEventListener(t, () => seen.push(t));
    }
    const r = await performAction({ kind: 'click', id: id('Go') }, { flash: false });
    expect(r).toEqual({ ok: true, detail: 'clicked [1] "Go"' });
    expect(seen).toEqual([
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
      'pointerdown',
      'mousedown',
      'focus',
      'pointerup',
      'mouseup',
      'click',
    ]);
    expect(document.activeElement).toBe(btn);
  });

  it('runs activation behaviour: toggles checkboxes, submits forms', async () => {
    const { id } = setup(
      '<form><input type="checkbox" aria-label="Agree"><button>Send</button></form>',
    );
    const submitted = vi.fn((e: Event) => {
      e.preventDefault();
    });
    document.querySelector('form')!.addEventListener('submit', submitted);
    await performAction({ kind: 'click', id: id('Agree') }, { flash: false });
    expect(document.querySelector('input')!.checked).toBe(true);
    await performAction({ kind: 'click', id: id('Send') }, { flash: false });
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('right-click fires contextmenu; hover fires only hover events', async () => {
    const { id } = setup('<button>Target</button>');
    const btn = document.querySelector('button')!;
    const seen: string[] = [];
    for (const t of ['contextmenu', 'click', 'mouseover', 'mousedown'])
      btn.addEventListener(t, (e) => seen.push(`${t}:${(e as MouseEvent).button}`));
    await performAction({ kind: 'rightClick', id: id('Target') }, { flash: false });
    expect(seen).toEqual(['mouseover:0', 'mousedown:2', 'contextmenu:2']);
    seen.length = 0;
    await performAction({ kind: 'hover', id: id('Target') }, { flash: false });
    expect(seen).toEqual(['mouseover:0']);
  });

  it('clicks the visible label standing in for a hidden checkbox', async () => {
    const { snap } = setup(
      '<input type="checkbox" id="t" style="opacity:0;position:absolute"><label for="t">Accept terms</label>',
    );
    const cb = snap.elements.find((e) => e.role === 'checkbox')!;
    const r = await performAction({ kind: 'check', id: cb.id, state: true }, { flash: false });
    expect(r.ok).toBe(true);
    expect(document.querySelector('input')!.checked).toBe(true);
  });

  it('reports a stale id specifically', async () => {
    const { id } = setup('<button>Gone soon</button>');
    const target = id('Gone soon');
    document.body.innerHTML = '';
    expect(await performAction({ kind: 'click', id: target })).toEqual({
      ok: false,
      error: 'Element [1] is no longer on the page. Use an id from the current ELEMENTS list.',
    });
  });
});

describe('type', () => {
  it('types character by character with beforeinput/input and fires change', async () => {
    const { id } = setup('<input aria-label="Search">');
    const input = document.querySelector('input')!;
    const events: string[] = [];
    for (const t of ['keydown', 'beforeinput', 'input', 'keyup', 'change'])
      input.addEventListener(t, () => events.push(t));
    const r = await performAction({ kind: 'type', id: id('Search'), text: 'ab' }, { flash: false });
    expect(r).toEqual({ ok: true, detail: 'typed 2 characters into [1] "Search"' });
    expect(input.value).toBe('ab');
    expect(events).toEqual([
      'keydown',
      'beforeinput',
      'input',
      'keyup',
      'keydown',
      'beforeinput',
      'input',
      'keyup',
      'change',
    ]);
  });

  it('replaces existing text and respects maxlength', async () => {
    const { id } = setup('<input aria-label="Code" value="AB" maxlength="4">');
    const r = await performAction(
      { kind: 'type', id: id('Code'), text: 'CDEFG' },
      { flash: false },
    );
    expect(document.querySelector('input')!.value).toBe('CDEF');
    expect(r.detail).toContain("stopped at the field's limit");
  });

  it('replaces the text of a contenteditable', async () => {
    const { id } = setup('<div contenteditable="true" aria-label="Bio">Old bio</div>');
    await performAction({ kind: 'type', id: id('Bio'), text: 'New' }, { flash: false });
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('New');
  });

  it('updates React-style controlled inputs (value tracker bypass)', async () => {
    const { id } = setup('<input aria-label="Name">');
    const input = document.querySelector('input')!;
    // What React does: an instance-level `value` property whose setter
    // records the "last rendered" value. Assigning el.value updates it, so
    // React would see no change; real typing (prototype setter) doesn't.
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let tracked = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this) as string;
      },
      set(v: string) {
        tracked = v;
        proto.set!.call(this, v);
      },
    });
    const changes: string[] = [];
    input.addEventListener('input', () => {
      // React's check: fire onChange only if the DOM value differs from the tracker.
      if (input.value !== tracked) {
        changes.push(input.value);
        tracked = input.value;
      }
    });
    await performAction({ kind: 'type', id: id('Name'), text: 'Ann' }, { flash: false });
    expect(changes).toEqual(['A', 'An', 'Ann']);
    // Direct assignment, for contrast, would have been invisible.
    input.value = 'Bob';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(changes).toEqual(['A', 'An', 'Ann']);
  });

  it('submit:true presses Enter and submits the form', async () => {
    const { id } = setup('<form><input aria-label="Q"><button>Go</button></form>');
    const submitted = vi.fn((e: Event) => {
      e.preventDefault();
    });
    document.querySelector('form')!.addEventListener('submit', submitted);
    const r = await performAction(
      { kind: 'type', id: id('Q'), text: 'boots', submit: true },
      { flash: false },
    );
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(r.detail).toBe('typed 5 characters into [1] "Q" and pressed Enter (submitted the form)');
  });

  it('a page that prevents Enter keeps the form unsubmitted', async () => {
    const { id } = setup('<form><input aria-label="Q"></form>');
    const submitted = vi.fn();
    const form = document.querySelector('form')!;
    form.addEventListener('submit', submitted);
    document.querySelector('input')!.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    await performAction({ kind: 'type', id: id('Q'), text: 'x', submit: true }, { flash: false });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('refuses password, card and one-time-code fields', async () => {
    const { snap } = setup(`
      <input type="password" aria-label="Password">
      <input aria-label="Card number" autocomplete="cc-number">
      <input aria-label="Code" autocomplete="one-time-code">`);
    for (const e of snap.elements) {
      const r = await performAction({ kind: 'type', id: e.id, text: 'secret' }, { flash: false });
      expect(r).toEqual({
        ok: false,
        error:
          'Tether never types into password, one-time-code or card fields. Ask the user to fill it in.',
      });
      const v = await performAction(
        { kind: 'setValue', id: e.id, value: 'secret' },
        { flash: false },
      );
      expect(v.ok).toBe(false);
    }
    expect([...document.querySelectorAll('input')].map((i) => i.value)).toEqual(['', '', '']);
  });

  it('types into contenteditable', async () => {
    const { id } = setup('<div contenteditable="true" aria-label="Editor"></div>');
    const r = await performAction({ kind: 'type', id: id('Editor'), text: 'hi' }, { flash: false });
    expect(r.ok).toBe(true);
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('hi');
  });

  it('explains when the target is not a text field', async () => {
    const { id } = setup('<button>Save</button>');
    expect(
      await performAction({ kind: 'type', id: id('Save'), text: 'x' }, { flash: false }),
    ).toEqual({
      ok: false,
      error: 'Element [1] is a button, not a text field. Pick a textbox to type into.',
    });
  });
});

describe('clear, setValue, select, check', () => {
  it('clears and sets values with input + change', async () => {
    const { id } = setup('<input aria-label="Qty" value="3"><input type="date" aria-label="When">');
    const events: string[] = [];
    document.querySelector('input')!.addEventListener('input', () => events.push('input'));
    document.querySelector('input')!.addEventListener('change', () => events.push('change'));
    await performAction({ kind: 'clear', id: id('Qty') }, { flash: false });
    expect(document.querySelector('input')!.value).toBe('');
    expect(events).toEqual(['input', 'change']);
    const r = await performAction(
      { kind: 'setValue', id: id('When'), value: '2026-11-05' },
      { flash: false },
    );
    expect(r.detail).toBe('set [2] "When" to "2026-11-05"');
  });

  it('selects by text, by value, by unique partial match, and lists options on a miss', async () => {
    const { id } = setup(
      '<select aria-label="Size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>',
    );
    const sel = document.querySelector('select')!;
    const changes: string[] = [];
    sel.addEventListener('change', () => changes.push(sel.value));
    await performAction({ kind: 'select', id: id('Size'), option: 'large' }, { flash: false });
    await performAction({ kind: 'select', id: id('Size'), option: 's' }, { flash: false });
    await performAction({ kind: 'select', id: id('Size'), option: 'Med' }, { flash: false });
    expect(changes).toEqual(['l', 's', 'm']);
    expect(
      await performAction({ kind: 'select', id: id('Size'), option: 'XL' }, { flash: false }),
    ).toEqual({
      ok: false,
      error: 'No option matching "XL" in [1]. Available options: "Small", "Medium", "Large".',
    });
  });

  it('selects in an ARIA listbox by clicking the option', async () => {
    const { id } = setup(
      '<div role="listbox" aria-label="Color"><div role="option">Red</div><div role="option">Blue</div></div>',
    );
    const picked: string[] = [];
    for (const o of document.querySelectorAll('[role=option]'))
      o.addEventListener('click', () => picked.push(o.textContent));
    const r = await performAction(
      { kind: 'select', id: id('Color'), option: 'blue' },
      { flash: false },
    );
    expect(r.ok).toBe(true);
    expect(picked).toEqual(['Blue']);
  });

  it('check sets the desired state, is idempotent, and refuses to uncheck a radio', async () => {
    const { id } = setup(
      '<input type="checkbox" aria-label="Gift"><input type="radio" name="r" aria-label="Fast" checked>',
    );
    expect(
      (await performAction({ kind: 'check', id: id('Gift'), state: true }, { flash: false }))
        .detail,
    ).toBe('checked [1] "Gift"');
    expect(
      (await performAction({ kind: 'check', id: id('Gift'), state: true }, { flash: false }))
        .detail,
    ).toBe('[1] "Gift" was already checked');
    expect(
      await performAction({ kind: 'check', id: id('Fast'), state: false }, { flash: false }),
    ).toMatchObject({ ok: false });
  });

  it('check on an ARIA switch toggles aria-checked through the page’s handler', async () => {
    const { id } = setup(
      '<div role="switch" aria-checked="false" aria-label="Wifi" tabindex="0"></div>',
    );
    const sw = document.querySelector('[role=switch]')!;
    sw.addEventListener('click', () =>
      sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')),
    );
    expect(
      await performAction({ kind: 'check', id: id('Wifi'), state: true }, { flash: false }),
    ).toEqual({ ok: true, detail: 'checked [1] "Wifi"' });
  });
});

describe('pressKey and scroll', () => {
  it('parses keys and combos', () => {
    expect(parseKey('Enter')).toEqual({ key: 'Enter', mods: {} });
    expect(parseKey('esc')).toEqual({ key: 'Escape', mods: {} });
    expect(parseKey('Ctrl+A')).toEqual({ key: 'A', mods: { ctrlKey: true } });
    expect(parseKey('cmd+shift+z')).toEqual({ key: 'z', mods: { metaKey: true, shiftKey: true } });
    expect(parseKey('Shift+Tab')).toEqual({ key: 'Tab', mods: { shiftKey: true } });
    expect(parseKey('Ctrl')).toBeNull();
    expect(parseKey('F13')).toBeNull();
  });

  it('Tab moves focus forward and back', async () => {
    const { id } = setup('<input aria-label="A"><input aria-label="B"><button>C</button>');
    document.querySelector('input')!.focus();
    await performAction({ kind: 'pressKey', key: 'Tab' }, { flash: false });
    expect((document.activeElement as HTMLInputElement).getAttribute('aria-label')).toBe('B');
    await performAction({ kind: 'pressKey', key: 'Shift+Tab' }, { flash: false });
    expect((document.activeElement as HTMLInputElement).getAttribute('aria-label')).toBe('A');
    expect(id('C')).toBe('3');
  });

  it('Enter in a field submits; Escape closes an open dialog; Ctrl+A selects all', async () => {
    const { id } = setup(
      '<form><input aria-label="Q" value="hello"></form><dialog open><p>Hi</p></dialog>',
    );
    const submitted = vi.fn((e: Event) => {
      e.preventDefault();
    });
    document.querySelector('form')!.addEventListener('submit', submitted);
    const enter = await performAction(
      { kind: 'pressKey', key: 'Enter', id: id('Q') },
      { flash: false },
    );
    expect(enter.detail).toBe('pressed Enter on [1] (submitted the form)');
    expect(submitted).toHaveBeenCalledTimes(1);
    const all = await performAction(
      { kind: 'pressKey', key: 'Ctrl+A', id: id('Q') },
      { flash: false },
    );
    expect(all.detail).toContain('selected all');
    const dlg = document.querySelector('dialog')!;
    dlg.close = vi.fn(() => {
      dlg.removeAttribute('open');
    });
    const esc = await performAction({ kind: 'pressKey', key: 'Escape' }, { flash: false });
    expect(esc.detail).toBe('pressed Escape (closed the dialog)');
  });

  it('Backspace deletes in a field; unknown keys are explained', async () => {
    const { id } = setup('<input aria-label="Q" value="abc">');
    await performAction({ kind: 'pressKey', key: 'Backspace', id: id('Q') }, { flash: false });
    expect(document.querySelector('input')!.value).toBe('ab');
    expect(await performAction({ kind: 'pressKey', key: 'Hyper' }, { flash: false })).toMatchObject(
      { ok: false },
    );
  });

  it('scroll reports position and edges', async () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const r = await performAction({ kind: 'scroll', direction: 'down' }, { flash: false });
    expect(scrollBy).toHaveBeenCalled();
    // jsdom can't scroll: the page reports it's already at the edge.
    expect(r).toEqual({ ok: true, detail: 'the page is already at the bottom' });
    const { id } = setup('<button>Far</button>');
    expect(await performAction({ kind: 'scroll', id: id('Far') }, { flash: false })).toEqual({
      ok: true,
      detail: 'scrolled [1] "Far" into view',
    });
  });
});

describe('setNativeValue', () => {
  it('works for inputs, textareas and selects', () => {
    document.body.innerHTML =
      '<input><textarea></textarea><select><option value="a">A</option><option value="b">B</option></select>';
    setNativeValue(document.querySelector('input')!, 'x');
    setNativeValue(document.querySelector('textarea')!, 'y');
    setNativeValue(document.querySelector('select')!, 'b');
    expect([
      document.querySelector('input')!.value,
      document.querySelector('textarea')!.value,
      document.querySelector('select')!.value,
    ]).toEqual(['x', 'y', 'b']);
  });
});
