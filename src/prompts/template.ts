import type { PromptTemplate } from './library';

/**
 * Slash commands: "/summarize focus on pricing" → the template, expanded.
 * {{page}} and {{selection}} don't inline page text (that would skip the
 * untrusted-content fence and the budget); they ask for the chip and read
 * as a reference to it.
 */

export interface SlashMatch {
  prompt: PromptTemplate;
  /** Text after the command. */
  input: string;
}

export interface Expansion {
  question: string;
  needs: { page: boolean; selection: boolean };
}

/** The prompt a message invokes, if it starts with a known /command. */
export function matchSlash(text: string, prompts: PromptTemplate[]): SlashMatch | null {
  const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const prompt = prompts.find((p) => p.command === m[1]);
  return prompt ? { prompt, input: (m[2] ?? '').trim() } : null;
}

/** Prompts whose command starts with what's typed after "/", for the menu. */
export function slashSuggestions(text: string, prompts: PromptTemplate[]): PromptTemplate[] {
  const m = /^\/([a-z0-9-]*)$/.exec(text);
  if (!m) return [];
  const q = m[1] ?? '';
  return prompts.filter((p) => p.command.startsWith(q)).slice(0, 8);
}

/** Page-derived values are inlined, so keep them on one short line. */
function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const VAR = /\{\{\s*(page|selection|url|title|input)\s*(?:\|([^}]*))?\}\}/g;

export function expandTemplate(
  template: string,
  values: { input: string; url: string; title: string },
): Expansion {
  const needs = { page: false, selection: false };
  const used = { input: false };
  const question = template.replace(VAR, (_all, name: string, fallback: string | undefined) => {
    switch (name) {
      case 'page':
        needs.page = true;
        return 'the page above';
      case 'selection':
        needs.selection = true;
        return 'the selected text above';
      case 'url':
        return oneLine(values.url) || (fallback ?? '');
      case 'title':
        return oneLine(values.title) || (fallback ?? '');
      default:
        used.input = true;
        return values.input || (fallback ?? '').trim();
    }
  });
  // A template that doesn't mention {{input}} still keeps what was typed.
  const extra = !used.input && values.input ? `\n\n${values.input}` : '';
  return { question: `${question.replace(/[ \t]+$/gm, '').trim()}${extra}`, needs };
}
