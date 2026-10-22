import { browser } from 'wxt/browser';

/**
 * The prompt library: named templates the composer runs as slash commands.
 *
 * Variables:
 *   {{page}}       attaches the current page (fenced, budgeted, shown as a chip)
 *   {{selection}}  attaches the selected text
 *   {{url}}        the tab's address
 *   {{title}}      the tab's title
 *   {{input}}      whatever follows the command; {{input|default}} when empty
 */

export interface PromptTemplate {
  id: string;
  /** Slash command without the slash: lowercase letters, digits and dashes. */
  command: string;
  name: string;
  template: string;
  description?: string;
}

export const PROMPTS_KEY = 'tether:prompts';
export const COMMAND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TEMPLATE = 4000;
const MAX_PROMPTS = 200;

export const DEFAULT_PROMPTS: PromptTemplate[] = [
  {
    id: 'builtin-summarize',
    command: 'summarize',
    name: 'Summarize',
    template: 'Summarize {{page}} in a few short paragraphs. {{input}}',
    description: 'A short summary of this page',
  },
  {
    id: 'builtin-tldr',
    command: 'tldr',
    name: 'TL;DR',
    template: 'Give a one-sentence TL;DR of {{page}}. {{input}}',
    description: 'One sentence on this page',
  },
  {
    id: 'builtin-bullets',
    command: 'bullets',
    name: 'Key points',
    template: 'List the key points of {{page}} as short bullets. {{input}}',
    description: 'This page as bullet points',
  },
  {
    id: 'builtin-explain',
    command: 'explain',
    name: 'Explain',
    template: 'Explain {{selection}} in plain language. {{input}}',
    description: 'Explain the selected text',
  },
  {
    id: 'builtin-eli5',
    command: 'eli5',
    name: 'Explain like I’m five',
    template: 'Explain {{selection}} as if I were five years old. {{input}}',
    description: 'The selection, very simply',
  },
  {
    id: 'builtin-translate',
    command: 'translate',
    name: 'Translate',
    template:
      'Translate {{selection}} into {{input|English}}. Keep the meaning and tone, and reply with only the translation.',
    description: 'Translate the selection (e.g. /translate French)',
  },
  {
    id: 'builtin-reply',
    command: 'reply',
    name: 'Draft a reply',
    template: 'Draft a reply to {{selection}}. {{input}}',
    description: 'A reply to the selected message (add the gist after the command)',
  },
];

export type ValidationResult =
  { ok: true; prompts: PromptTemplate[] } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check a whole library (an import, or what's in storage). All or nothing:
 * the first problem is reported and nothing is accepted.
 */
export function validatePrompts(raw: unknown): ValidationResult {
  const list = isRecord(raw) && Array.isArray(raw.prompts) ? raw.prompts : raw;
  if (!Array.isArray(list)) return { ok: false, error: 'Expected a list of prompts.' };
  if (list.length > MAX_PROMPTS) return { ok: false, error: `At most ${MAX_PROMPTS} prompts.` };
  const seen = new Set<string>();
  const out: PromptTemplate[] = [];
  for (const [i, item] of list.entries()) {
    const at = `Prompt ${i + 1}`;
    if (!isRecord(item)) return { ok: false, error: `${at} isn’t an object.` };
    const { command, name, template, description, id } = item;
    if (typeof command !== 'string' || !COMMAND_RE.test(command)) {
      return {
        ok: false,
        error: `${at}: the command must be lowercase letters, digits or dashes (got ${JSON.stringify(command)}).`,
      };
    }
    if (seen.has(command)) return { ok: false, error: `${at}: /${command} is used twice.` };
    seen.add(command);
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: `${at} has no name.` };
    if (typeof template !== 'string' || !template.trim()) {
      return { ok: false, error: `${at} (/${command}) has no template.` };
    }
    if (template.length > MAX_TEMPLATE) {
      return {
        ok: false,
        error: `${at} (/${command}): the template is over ${MAX_TEMPLATE} characters.`,
      };
    }
    if (description !== undefined && typeof description !== 'string') {
      return { ok: false, error: `${at} (/${command}): the description must be text.` };
    }
    out.push({
      id: typeof id === 'string' && id ? id : crypto.randomUUID(),
      command,
      name: name.trim(),
      template,
      ...(description?.trim() ? { description: description.trim() } : {}),
    });
  }
  return { ok: true, prompts: out };
}

export async function getPrompts(): Promise<PromptTemplate[]> {
  const stored = (await browser.storage.local.get(PROMPTS_KEY))[PROMPTS_KEY];
  if (stored === undefined) return structuredClone(DEFAULT_PROMPTS);
  const v = validatePrompts(stored);
  return v.ok ? v.prompts : structuredClone(DEFAULT_PROMPTS);
}

export async function savePrompts(prompts: PromptTemplate[]): Promise<void> {
  const v = validatePrompts(prompts);
  if (!v.ok) throw new Error(v.error);
  await browser.storage.local.set({ [PROMPTS_KEY]: v.prompts });
}

export async function resetPrompts(): Promise<void> {
  await browser.storage.local.remove(PROMPTS_KEY);
}

/** Subscribe to library changes from any context. Returns an unsubscribe function. */
export function watchPrompts(callback: (prompts: PromptTemplate[]) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area !== 'local' || !(PROMPTS_KEY in changes)) return;
    const next = changes[PROMPTS_KEY].newValue;
    if (next === undefined) {
      callback(structuredClone(DEFAULT_PROMPTS));
      return;
    }
    const v = validatePrompts(next);
    callback(v.ok ? v.prompts : structuredClone(DEFAULT_PROMPTS));
  };
  browser.storage.onChanged.addListener(listener);
  return () => {
    browser.storage.onChanged.removeListener(listener);
  };
}

/** The export file: versioned so later formats can still read it. */
export function exportPrompts(prompts: PromptTemplate[]): string {
  return `${JSON.stringify({ format: 'tether-prompts', version: 1, prompts }, null, 2)}\n`;
}
