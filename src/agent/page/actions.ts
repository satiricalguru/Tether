import { isSensitiveField, resolveElement, resolveTarget, roleOf } from './snapshot';
import type { ActResult, PageAction } from './types';

/**
 * Perform an agent action on an element from the latest snapshot, the way a
 * person would: realistic pointer/keyboard event sequences, values set
 * through the native setter so framework-controlled inputs (React, Vue)
 * notice, and the browser's own default actions (activation, form submit).
 */

const SENSITIVE_ERROR =
  'Tether never types into password, one-time-code or card fields. Ask the user to fill it in.';

function stale(id: string): ActResult {
  return {
    ok: false,
    error: `Element [${id}] is no longer on the page. Use an id from the current ELEMENTS list.`,
  };
}

function winOf(el: Element): Window & typeof globalThis {
  return el.ownerDocument.defaultView ?? window;
}

function label(id: string, el: Element): string {
  const name = (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
  return name ? `[${id}] "${name.slice(0, 40)}"` : `[${id}]`;
}

// ---------- presentation ----------

function scrollIntoView(el: Element): void {
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    try {
      el.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'instant' as ScrollBehavior,
      });
    } catch {
      el.scrollIntoView();
    }
  }
}

/** A brief outline so a person watching can see what the agent touched. */
function flash(el: Element): void {
  const h = el as HTMLElement;
  if (!('style' in h)) return;
  const prev = { outline: h.style.outline, offset: h.style.outlineOffset };
  h.style.outline = '2px solid #3d5afe';
  h.style.outlineOffset = '2px';
  setTimeout(() => {
    h.style.outline = prev.outline;
    h.style.outlineOffset = prev.offset;
  }, 600);
}

// ---------- events ----------

function center(el: Element): { clientX: number; clientY: number } {
  const r = el.getBoundingClientRect();
  return { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
}

interface Mods {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

function pointer(el: Element, type: string, init: MouseEventInit): boolean {
  const W = winOf(el);
  const base: PointerEventInit = {
    bubbles: !['pointerenter', 'pointerleave'].includes(type),
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...init,
  };
  const Ctor = typeof W.PointerEvent === 'function' ? W.PointerEvent : W.MouseEvent;
  return el.dispatchEvent(new Ctor(type, base));
}

function mouse(el: Element, type: string, init: MouseEventInit): boolean {
  const W = winOf(el);
  return el.dispatchEvent(
    new W.MouseEvent(type, {
      bubbles: !['mouseenter', 'mouseleave'].includes(type),
      cancelable: true,
      composed: true,
      ...init,
    }),
  );
}

function isFocusable(el: Element): boolean {
  const h = el as HTMLElement;
  return (
    typeof h.focus === 'function' &&
    (h.tabIndex >= 0 ||
      el.hasAttribute('tabindex') ||
      el.matches('a[href], button, input, select, textarea, summary, [contenteditable]'))
  );
}

function hoverSequence(el: Element, at: MouseEventInit): void {
  pointer(el, 'pointerover', at);
  pointer(el, 'pointerenter', at);
  mouse(el, 'mouseover', at);
  mouse(el, 'mouseenter', at);
  pointer(el, 'pointermove', at);
  mouse(el, 'mousemove', at);
}

function clickSequence(el: Element, mods: Mods = {}): void {
  const at = { ...center(el), ...mods };
  hoverSequence(el, at);
  const down = { ...at, button: 0, buttons: 1 };
  const up = { ...at, button: 0, buttons: 0 };
  const proceed = pointer(el, 'pointerdown', down) && mouse(el, 'mousedown', down);
  // A prevented mousedown suppresses focus, as in a real browser.
  if (proceed && isFocusable(el)) (el as HTMLElement).focus();
  pointer(el, 'pointerup', up);
  mouse(el, 'mouseup', up);
  // A dispatched click runs the element's activation behavior (links,
  // checkboxes, submit buttons) like a real one.
  mouse(el, 'click', { ...up, detail: 1 });
}

function key(el: Element, type: string, k: string, mods: Mods = {}): boolean {
  const W = winOf(el);
  return el.dispatchEvent(
    new W.KeyboardEvent(type, {
      key: k,
      code: codeFor(k),
      bubbles: true,
      cancelable: true,
      composed: true,
      ...mods,
    }),
  );
}

function codeFor(k: string): string {
  if (k.length === 1) {
    if (/[a-z]/i.test(k)) return `Key${k.toUpperCase()}`;
    if (/\d/.test(k)) return `Digit${k}`;
    if (k === ' ') return 'Space';
    return '';
  }
  return k;
}

// ---------- values ----------

type Field = HTMLInputElement | HTMLTextAreaElement;

function isTextField(el: Element): el is Field {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type.toLowerCase();
  return ![
    'checkbox',
    'radio',
    'submit',
    'button',
    'reset',
    'image',
    'file',
    'range',
    'color',
    'hidden',
  ].includes(type);
}

/**
 * Set a value via the prototype setter. Frameworks like React install an
 * instance-level `value` property to track the last value they rendered;
 * assigning `el.value` directly updates that tracker too, so the framework
 * sees no change and ignores the input event. The prototype setter bypasses
 * it, exactly like a user's typing does.
 */
export function setNativeValue(el: Field | HTMLSelectElement, value: string): void {
  const W = winOf(el);
  const proto =
    el.tagName === 'TEXTAREA'
      ? W.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? W.HTMLSelectElement.prototype
        : W.HTMLInputElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with an explicit receiver below
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function inputEvent(el: Element, inputType: string, data: string | null): void {
  const W = winOf(el);
  const Ctor = typeof W.InputEvent === 'function' ? W.InputEvent : W.Event;
  const init: InputEventInit = { bubbles: true, composed: true, inputType, data };
  el.dispatchEvent(new Ctor('input', init));
}

function beforeInput(el: Element, inputType: string, data: string | null): boolean {
  const W = winOf(el);
  if (typeof W.InputEvent !== 'function') return true;
  return el.dispatchEvent(
    new W.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType,
      data,
    }),
  );
}

function change(el: Element): void {
  el.dispatchEvent(new (winOf(el).Event)('change', { bubbles: true }));
}

function caretToEnd(el: Field): void {
  try {
    el.setSelectionRange(el.value.length, el.value.length);
  } catch {
    // email/number inputs don't support selection ranges
  }
}

function isEditableHost(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}

function submitFrom(el: Element): boolean {
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (!form) return false;
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    const btn = form.querySelector<HTMLElement>(
      'button:not([type]), button[type="submit"], input[type="submit"]',
    );
    if (btn) btn.click();
    else form.submit();
  }
  return true;
}

/** Press Enter in a field: keydown, then (unless prevented) the implicit submit a browser would do. */
function pressEnter(el: Element): string {
  const allowed = key(el, 'keydown', 'Enter');
  key(el, 'keypress', 'Enter');
  let what = 'pressed Enter';
  if (allowed && el.tagName === 'INPUT' && submitFrom(el))
    what = 'pressed Enter (submitted the form)';
  key(el, 'keyup', 'Enter');
  return what;
}

async function typeInto(
  id: string,
  el: Element,
  text: string,
  submit: boolean,
): Promise<ActResult> {
  if (isSensitiveField(el)) return { ok: false, error: SENSITIVE_ERROR };
  const editable = isEditableHost(el)
    ? el
    : el.closest('[contenteditable]:not([contenteditable="false"])');
  if (!isTextField(el) && !editable) {
    return {
      ok: false,
      error: `Element [${id}] is a ${roleOf(el)}, not a text field. Pick a textbox to type into.`,
    };
  }
  const target = (isTextField(el) ? el : editable) as HTMLElement;
  clickSequence(target);
  target.focus();
  let typed = 0;
  let wanted = 0;
  if (isTextField(target)) {
    // type replaces the field's text: what a model means by "type X into Y".
    if (target.value !== '' && beforeInput(target, 'deleteContentBackward', null)) {
      setNativeValue(target, '');
      inputEvent(target, 'deleteContentBackward', null);
    }
    caretToEnd(target);
    const max = target.maxLength > 0 ? target.maxLength : Infinity;
    for (const ch of text) {
      wanted++;
      if (target.value.length >= max) break;
      key(target, 'keydown', ch);
      key(target, 'keypress', ch);
      if (beforeInput(target, 'insertText', ch)) {
        setNativeValue(target, target.value + ch);
        inputEvent(target, 'insertText', ch);
        typed++;
      }
      key(target, 'keyup', ch);
    }
  } else {
    const doc = target.ownerDocument;
    const sel = doc.getSelection();
    if (sel) {
      const range = doc.createRange();
      // Select everything, then delete it: type replaces the old text.
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (target.textContent && beforeInput(target, 'deleteContentBackward', null)) {
      let deleted: boolean;
      try {
        /* eslint-disable @typescript-eslint/no-deprecated */
        deleted = typeof doc.execCommand === 'function' && doc.execCommand('delete', false);
        /* eslint-enable @typescript-eslint/no-deprecated */
      } catch {
        deleted = false;
      }
      if (!deleted) {
        target.textContent = '';
        inputEvent(target, 'deleteContentBackward', null);
      }
    }
    for (const ch of text) {
      wanted++;
      key(target, 'keydown', ch);
      if (beforeInput(target, 'insertText', ch)) {
        let inserted: boolean;
        try {
          // Deprecated but still the one way to insert text that editors' undo stacks and handlers see.
          /* eslint-disable @typescript-eslint/no-deprecated */
          inserted =
            typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, ch);
          /* eslint-enable @typescript-eslint/no-deprecated */
        } catch {
          inserted = false;
        }
        if (!inserted) {
          target.append(doc.createTextNode(ch));
          inputEvent(target, 'insertText', ch);
        }
        typed++;
      }
      key(target, 'keyup', ch);
    }
  }
  change(target);
  let detail = `typed ${typed} character${typed === 1 ? '' : 's'} into ${label(id, el)}`;
  if (typed < wanted) detail += ` (stopped at the field's limit or a blocked input)`;
  if (submit) detail += ` and ${pressEnter(target).replace(/^pressed/, 'pressed')}`;
  await Promise.resolve();
  return { ok: true, detail };
}

// ---------- select / check ----------

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function pickOption<T>(
  items: T[],
  text: (t: T) => string,
  value: (t: T) => string,
  want: string,
): T | undefined {
  const w = norm(want);
  return (
    items.find((o) => norm(text(o)) === w) ??
    items.find((o) => norm(value(o)) === w) ??
    (() => {
      const partial = items.filter((o) => norm(text(o)).includes(w));
      return partial.length === 1 ? partial[0] : undefined;
    })()
  );
}

function listOptions(names: string[]): string {
  const shown = names
    .filter(Boolean)
    .slice(0, 10)
    .map((n) => JSON.stringify(n));
  return shown.length
    ? ` Available options: ${shown.join(', ')}${names.length > 10 ? ', …' : ''}.`
    : '';
}

async function selectOption(id: string, el: Element, option: string): Promise<ActResult> {
  if (el.tagName === 'SELECT') {
    const s = el as HTMLSelectElement;
    const opts = [...s.options];
    const opt = pickOption(
      opts,
      (o) => o.textContent,
      (o) => o.value,
      option,
    );
    if (!opt) {
      return {
        ok: false,
        error: `No option matching ${JSON.stringify(option)} in [${id}].${listOptions(opts.map((o) => o.textContent.trim()))}`,
      };
    }
    if (opt.disabled)
      return { ok: false, error: `Option ${JSON.stringify(opt.textContent.trim())} is disabled.` };
    s.focus();
    if (s.multiple) opt.selected = true;
    else setNativeValue(s, opt.value);
    inputEvent(s, 'insertReplacementText', null);
    change(s);
    return {
      ok: true,
      detail: `selected ${JSON.stringify(opt.textContent.trim())} in ${label(id, el)}`,
    };
  }
  // ARIA listbox / combobox: open it, then click the option.
  const role = roleOf(el);
  if (role !== 'listbox' && role !== 'combobox') {
    return {
      ok: false,
      error: `Element [${id}] is a ${role}, not a dropdown. Use click for buttons and links.`,
    };
  }
  if (role === 'combobox') {
    clickSequence(el);
    await new Promise((r) => setTimeout(r, 120));
  }
  const doc = el.ownerDocument;
  const controls = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
  const scope =
    (controls ? doc.getElementById(controls.split(/\s+/)[0] ?? '') : null) ??
    (role === 'listbox' ? el : doc);
  const opts = [...scope.querySelectorAll('[role="option"]')];
  const opt = pickOption(
    opts,
    (o) => o.textContent,
    (o) => o.getAttribute('data-value') ?? '',
    option,
  );
  if (!opt) {
    return {
      ok: false,
      error: `No option matching ${JSON.stringify(option)} in [${id}].${listOptions(opts.map((o) => o.textContent.trim()))}`,
    };
  }
  scrollIntoView(opt);
  clickSequence(opt);
  return {
    ok: true,
    detail: `selected ${JSON.stringify(opt.textContent.trim())} in ${label(id, el)}`,
  };
}

function checkedState(el: Element): boolean | undefined {
  if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) {
    return (el as HTMLInputElement).checked;
  }
  const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
  if (aria !== null) return aria === 'true';
  return undefined;
}

function check(id: string, el: Element, want: boolean): ActResult {
  const now = checkedState(el);
  if (now === undefined)
    return {
      ok: false,
      error: `Element [${id}] is a ${roleOf(el)}, not a checkbox, radio or switch.`,
    };
  if (now === want)
    return { ok: true, detail: `${label(id, el)} was already ${want ? 'checked' : 'unchecked'}` };
  if (!want && (el as HTMLInputElement).type === 'radio') {
    return {
      ok: false,
      error: `A radio button can't be unchecked directly; select another option in its group.`,
    };
  }
  clickSequence(resolveTarget(id) ?? el);
  if (checkedState(el) !== want) {
    return {
      ok: false,
      error: `Clicking ${label(id, el)} didn't change it. It may be read-only, or need a different element.`,
    };
  }
  return { ok: true, detail: `${want ? 'checked' : 'unchecked'} ${label(id, el)}` };
}

// ---------- keys ----------

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: ' ',
  spacebar: ' ',
};

export function parseKey(spec: string): { key: string; mods: Mods } | null {
  const parts = spec
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: Mods = {};
  let keyName: string | undefined;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control') mods.ctrlKey = true;
    else if (l === 'shift') mods.shiftKey = true;
    else if (l === 'alt' || l === 'option') mods.altKey = true;
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'super') mods.metaKey = true;
    else keyName = p;
  }
  if (!keyName) return null;
  const k = KEY_ALIASES[keyName.toLowerCase()] ?? (keyName.length === 1 ? keyName : undefined);
  return k === undefined ? null : { key: k, mods };
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

function moveFocus(doc: Document, from: Element | null, backwards: boolean): Element | undefined {
  const all = [...doc.querySelectorAll<HTMLElement>(TABBABLE)].filter((e) => {
    const cs = (doc.defaultView ?? window).getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  if (all.length === 0) return undefined;
  const i = from ? all.indexOf(from as HTMLElement) : -1;
  const next = backwards ? all[(i <= 0 ? all.length : i) - 1] : all[(i + 1) % all.length];
  next?.focus();
  return next;
}

function pressKey(spec: string, id: string | undefined, el: Element | undefined): ActResult {
  const parsed = parseKey(spec);
  if (!parsed) {
    return {
      ok: false,
      error: `Unknown key ${JSON.stringify(spec)}. Use e.g. Enter, Escape, Tab, ArrowDown, Backspace or Ctrl+A.`,
    };
  }
  const { key: k, mods } = parsed;
  const doc = el?.ownerDocument ?? document;
  const target = el ?? doc.activeElement ?? doc.body;
  if (el && isFocusable(el) && doc.activeElement !== el) {
    (el as HTMLElement).focus();
    // Focusing by id (not by click) leaves the caret at the end, where a
    // model expects Backspace to act.
    if (isTextField(el)) caretToEnd(el);
  }
  const allowed = key(target, 'keydown', k, mods);
  let effect = '';
  if (allowed) {
    const field = isTextField(target) ? target : undefined;
    if (k === 'Tab') {
      const next = moveFocus(doc, target, !!mods.shiftKey);
      effect = next ? ' (moved focus)' : '';
    } else if (k === 'Enter') {
      if (target.tagName === 'INPUT' && submitFrom(target)) effect = ' (submitted the form)';
      else if (target.matches('button, a[href], [role="button"], [role="link"], summary')) {
        clickSequence(target);
        effect = ' (activated it)';
      }
    } else if (
      k === ' ' &&
      target.matches(
        'button, [role="button"], input[type="checkbox"], [role="checkbox"], [role="switch"]',
      )
    ) {
      clickSequence(target);
      effect = ' (activated it)';
    } else if (k === 'Escape') {
      const dialog = doc.querySelector<HTMLDialogElement>('dialog[open]');
      if (dialog && typeof dialog.close === 'function') {
        dialog.close();
        effect = ' (closed the dialog)';
      }
    } else if ((mods.ctrlKey || mods.metaKey) && k.toLowerCase() === 'a' && field) {
      field.select();
      effect = ' (selected all)';
    } else if (k === 'Backspace' && field && !isSensitiveField(field)) {
      if (beforeInput(field, 'deleteContentBackward', null)) {
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        const next =
          start !== end
            ? field.value.slice(0, start) + field.value.slice(end)
            : field.value.slice(0, Math.max(0, start - 1)) + field.value.slice(start);
        setNativeValue(field, next);
        inputEvent(field, 'deleteContentBackward', null);
      }
    } else if (
      !field &&
      ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(k)
    ) {
      const W = winOf(target);
      const vh = W.innerHeight || 600;
      const dy = {
        ArrowDown: 40,
        ArrowUp: -40,
        PageDown: vh * 0.9,
        PageUp: -vh * 0.9,
        ' ': vh * 0.9,
      }[k];
      if (k === 'Home') W.scrollTo(0, 0);
      else if (k === 'End') W.scrollTo(0, doc.documentElement.scrollHeight);
      else if (dy !== undefined) W.scrollBy(0, dy);
    }
  }
  key(target, 'keyup', k, mods);
  const on = id ? ` on [${id}]` : '';
  return { ok: true, detail: `pressed ${spec}${on}${allowed ? effect : ' (the page handled it)'}` };
}

// ---------- scroll ----------

function scrollableAncestorOrBiggest(doc: Document): Element | undefined {
  const W = doc.defaultView ?? window;
  let best: Element | undefined;
  let bestArea = 0;
  for (const el of doc.querySelectorAll('*')) {
    if (el.scrollHeight - el.clientHeight < 40) continue;
    const oy = W.getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function scrollPage(direction: 'up' | 'down', amount: number | undefined): ActResult {
  const W = window;
  const doc = document;
  const vh = W.innerHeight || 600;
  // Small numbers are screens; larger ones are pixels.
  const px = amount === undefined ? vh * 0.8 : amount <= 10 ? amount * vh : amount;
  const dy = direction === 'up' ? -px : px;
  const before = W.scrollY;
  W.scrollBy(0, dy);
  const docEl = doc.documentElement;
  if (Math.abs(W.scrollY - before) < 1) {
    // The window doesn't scroll: apps often scroll an inner container.
    const box = scrollableAncestorOrBiggest(doc);
    if (box) {
      const b0 = box.scrollTop;
      box.scrollTop += dy;
      const moved = Math.abs(box.scrollTop - b0) >= 1;
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      const atStart = box.scrollTop <= 0;
      return {
        ok: true,
        detail: moved
          ? `scrolled the list ${direction} to ${Math.round(box.scrollTop)} of ${box.scrollHeight}px${atEnd && direction === 'down' ? ' (reached the bottom)' : ''}${atStart && direction === 'up' ? ' (reached the top)' : ''}`
          : `the list is already at the ${direction === 'down' ? 'bottom' : 'top'}`,
      };
    }
    return {
      ok: true,
      detail: `the page is already at the ${direction === 'down' ? 'bottom' : 'top'}`,
    };
  }
  const bottom = W.scrollY + vh >= docEl.scrollHeight - 2;
  const top = W.scrollY <= 0;
  return {
    ok: true,
    detail: `scrolled ${direction} to ${Math.round(W.scrollY)} of ${docEl.scrollHeight}px${bottom && direction === 'down' ? ' (reached the bottom)' : ''}${top && direction === 'up' ? ' (reached the top)' : ''}`,
  };
}

// ---------- entry point ----------

export async function performAction(
  action: PageAction,
  opts: { flash?: boolean } = {},
): Promise<ActResult> {
  const withFlash = opts.flash ?? true;
  const id = action.id;
  if (id === undefined) {
    // Only scroll and pressKey have an optional target.
    if (action.kind === 'scroll') return scrollPage(action.direction ?? 'down', action.amount);
    if (action.kind === 'pressKey') return pressKey(action.key, undefined, undefined);
    return { ok: false, error: 'This action needs an element id.' };
  }
  const el = resolveElement(id);
  if (!el) return stale(id);
  const target = resolveTarget(id) ?? el;
  scrollIntoView(target);
  if (withFlash) flash(target);

  switch (action.kind) {
    case 'click':
      clickSequence(target);
      return { ok: true, detail: `clicked ${label(id, el)}` };
    case 'rightClick': {
      const at = center(target);
      hoverSequence(target, at);
      pointer(target, 'pointerdown', { ...at, button: 2, buttons: 2 });
      mouse(target, 'mousedown', { ...at, button: 2, buttons: 2 });
      pointer(target, 'pointerup', { ...at, button: 2, buttons: 0 });
      mouse(target, 'mouseup', { ...at, button: 2, buttons: 0 });
      mouse(target, 'contextmenu', { ...at, button: 2, buttons: 0 });
      return { ok: true, detail: `right-clicked ${label(id, el)}` };
    }
    case 'hover':
      hoverSequence(target, center(target));
      return { ok: true, detail: `hovered over ${label(id, el)}` };
    case 'type':
      return typeInto(id, el, action.text, action.submit ?? false);
    case 'clear': {
      if (!isTextField(el))
        return { ok: false, error: `Element [${id}] is a ${roleOf(el)}, not a text field.` };
      el.focus();
      if (beforeInput(el, 'deleteContentBackward', null)) {
        setNativeValue(el, '');
        inputEvent(el, 'deleteContentBackward', null);
        change(el);
      }
      return { ok: true, detail: `cleared ${label(id, el)}` };
    }
    case 'setValue': {
      if (
        el.tagName === 'SELECT' ||
        roleOf(el) === 'listbox' ||
        (roleOf(el) === 'combobox' && el.tagName !== 'INPUT')
      ) {
        return selectOption(id, el, action.value);
      }
      if (isSensitiveField(el)) return { ok: false, error: SENSITIVE_ERROR };
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        return {
          ok: false,
          error: `Element [${id}] is a ${roleOf(el)}; setValue works on form fields.`,
        };
      }
      const field = el as Field;
      field.focus();
      setNativeValue(field, action.value);
      inputEvent(field, 'insertReplacementText', action.value);
      change(field);
      return { ok: true, detail: `set ${label(id, el)} to ${JSON.stringify(field.value)}` };
    }
    case 'select':
      return selectOption(id, el, action.option);
    case 'check':
      return check(id, el, action.state);
    case 'pressKey':
      return pressKey(action.key, id, el);
    case 'scroll':
      return { ok: true, detail: `scrolled ${label(id, el)} into view` };
  }
}
