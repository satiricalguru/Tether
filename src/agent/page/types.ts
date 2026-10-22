/**
 * Contract between the page engine (content script) and the agent loop
 * (background). Plain data only: it crosses runtime messaging.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotElement {
  /** Per-snapshot id: "12", or "3.12" for element 12 inside same-origin frame 3. */
  id: string;
  tag: string;
  /** textbox, searchbox, button, link, checkbox, radio, combobox, listbox, option, tab, menuitem, switch, slider, spinbutton, textarea, generic… */
  role: string;
  /** Accessible name, ≤ 80 chars. */
  name: string;
  /** Current value for form fields. Passwords are never included (shown as "••••"). */
  value?: string;
  /** e.g. ["checked"], ["unchecked"], ["expanded"], ["selected"], ["required"], ["readonly"]. */
  state?: string[];
  /** Input type for <input>. */
  type?: string;
  /** autocomplete attribute, used by the guard (cc-number, one-time-code, current-password…). */
  autocomplete?: string;
  /** Short hierarchy hint: 'in form "Checkout"', 'in dialog "Sign in"', 'in nav', 'in frame 2'. */
  hint?: string;
  /** Absolute URL for links. */
  href?: string;
  /** For links: has a download attribute. */
  download?: boolean;
  /** First options of a <select> / listbox. */
  options?: string[];
  /** Submits a form when clicked (submit button / input[type=submit|image] in a form). */
  submits?: boolean;
  /** Inside a <form>. */
  inForm?: boolean;
  inViewport: boolean;
  /** Top-level viewport coordinates (frames already offset). */
  rect: Rect;
}

export interface FrameInfo {
  index: number;
  url: string;
  /** Cross-origin frames can't be read; they're listed so the model knows they exist. */
  opaque: boolean;
  name?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** Elements left out to fit the budget (count; the reason is logged). */
  dropped: number;
  frames: FrameInfo[];
  /** Readable text digest (visibility-filtered), already truncated. */
  text: string;
  /** Visible links (same as PageExtract.links). */
  links: { text: string; url: string }[];
  scroll: { y: number; height: number; viewport: number };
  /** Hash of the interactive state (elements, values, URL, visible text) for no-op detection. */
  hash: string;
  /** A CAPTCHA / bot check is on the page. */
  captcha: boolean;
  /** An open modal dialog, if any (its name). */
  dialog?: string;
}

export interface SnapshotOptions {
  /** Task text, for prioritizing elements when over budget. */
  task?: string;
  /** Id acted on last (from the previous snapshot), for proximity priority. */
  lastId?: string;
  /** Element token budget (default 4000). */
  maxTokens?: number;
  /** Readable-text budget in characters (default 6000). */
  maxTextChars?: number;
}

export type PageAction =
  | { kind: 'click' | 'rightClick' | 'hover'; id: string }
  | { kind: 'type'; id: string; text: string; submit?: boolean }
  | { kind: 'clear'; id: string }
  | { kind: 'setValue'; id: string; value: string }
  | { kind: 'select'; id: string; option: string }
  | { kind: 'check'; id: string; state: boolean }
  | { kind: 'pressKey'; key: string; id?: string }
  | { kind: 'scroll'; direction?: 'up' | 'down'; id?: string; amount?: number };

export interface ActResult {
  ok: boolean;
  /** Why it failed, specific enough to feed back to the model. */
  error?: string;
  /** e.g. 'selected "Large"', 'typed 12 chars and pressed Enter'. */
  detail?: string;
}

/** For the debugger backend: where to click, in top-level viewport CSS pixels. */
export interface ElementPoint {
  x: number;
  y: number;
}
