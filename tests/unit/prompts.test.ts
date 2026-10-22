import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DEFAULT_PROMPTS,
  PROMPTS_KEY,
  exportPrompts,
  getPrompts,
  resetPrompts,
  savePrompts,
  validatePrompts,
  watchPrompts,
  type PromptTemplate,
} from '@/prompts/library';
import { expandTemplate, matchSlash, slashSuggestions } from '@/prompts/template';

const p = (command: string, template: string): PromptTemplate => ({
  id: command,
  command,
  name: command,
  template,
});

describe('expandTemplate', () => {
  const values = { input: '', url: 'https://a.test/x', title: 'A page' };

  it('turns {{page}} and {{selection}} into chip requests, not inlined text', () => {
    const e = expandTemplate('Summarize {{page}} and compare with {{selection}}.', values);
    expect(e.needs).toEqual({ page: true, selection: true });
    expect(e.question).toBe('Summarize the page above and compare with the selected text above.');
  });

  it('substitutes url, title and input, with defaults for an empty input', () => {
    expect(
      expandTemplate('{{title}} ({{url}}) into {{input|English}}', { ...values, input: '' })
        .question,
    ).toBe('A page (https://a.test/x) into English');
    expect(
      expandTemplate('into {{ input | English }}', { ...values, input: 'French' }).question,
    ).toBe('into French');
  });

  it('keeps typed text when the template has no {{input}}', () => {
    expect(
      expandTemplate('Summarize {{page}}.', { ...values, input: 'focus on pricing' }).question,
    ).toBe('Summarize the page above.\n\nfocus on pricing');
  });

  it('drops a trailing empty {{input}} cleanly', () => {
    expect(expandTemplate('Summarize {{page}}. {{input}}', values).question).toBe(
      'Summarize the page above.',
    );
  });

  it('keeps page-derived values on one short line', () => {
    const e = expandTemplate('{{title}}', {
      ...values,
      title: `Line one\n\nline two ${'x'.repeat(400)}`,
    });
    expect(e.question).not.toContain('\n');
    expect(e.question.length).toBeLessThanOrEqual(300);
  });
});

describe('slash commands', () => {
  const prompts = [p('summarize', 's'), p('summary-short', 'ss'), p('translate', 't')];

  it('matches a known command and the text after it', () => {
    expect(matchSlash('/translate  French please', prompts)).toMatchObject({
      prompt: { command: 'translate' },
      input: 'French please',
    });
    expect(matchSlash('/summarize', prompts)?.input).toBe('');
  });

  it('ignores unknown commands and text that merely contains a slash', () => {
    expect(matchSlash('/nope hi', prompts)).toBeNull();
    expect(matchSlash('what is a/b testing', prompts)).toBeNull();
  });

  it('suggests by prefix only while the command is being typed', () => {
    expect(slashSuggestions('/sum', prompts).map((x) => x.command)).toEqual([
      'summarize',
      'summary-short',
    ]);
    expect(slashSuggestions('/', prompts)).toHaveLength(3);
    expect(slashSuggestions('/summarize ', prompts)).toEqual([]);
    expect(slashSuggestions('hello', prompts)).toEqual([]);
  });
});

describe('the library', () => {
  it('starts with the built-in prompts', async () => {
    await expect(getPrompts()).resolves.toEqual(DEFAULT_PROMPTS);
    expect(new Set(DEFAULT_PROMPTS.map((x) => x.command)).size).toBe(DEFAULT_PROMPTS.length);
    expect(validatePrompts(DEFAULT_PROMPTS).ok).toBe(true);
  });

  it('saves, notifies other contexts and resets', async () => {
    const seen: PromptTemplate[][] = [];
    const unwatch = watchPrompts((x) => seen.push(x));
    await savePrompts([p('mine', 'Do {{input}}')]);
    await expect(getPrompts()).resolves.toMatchObject([{ command: 'mine' }]);
    await resetPrompts();
    await expect(getPrompts()).resolves.toEqual(DEFAULT_PROMPTS);
    unwatch();
    expect(seen.map((x) => x[0]?.command)).toEqual(['mine', DEFAULT_PROMPTS[0]?.command]);
  });

  it('refuses to save an invalid library', async () => {
    await expect(savePrompts([p('Bad Command', 'x')])).rejects.toThrow(/lowercase/);
  });

  it('falls back to the defaults if storage holds garbage', async () => {
    await fakeBrowser.storage.local.set({ [PROMPTS_KEY]: { nope: true } });
    await expect(getPrompts()).resolves.toEqual(DEFAULT_PROMPTS);
  });
});

describe('import validation', () => {
  it('round-trips an export', () => {
    const v = validatePrompts(JSON.parse(exportPrompts(DEFAULT_PROMPTS)));
    expect(v).toEqual({ ok: true, prompts: DEFAULT_PROMPTS });
  });

  it('accepts a bare list and fills in missing ids', () => {
    const v = validatePrompts([{ command: 'x', name: 'X', template: 'T' }]);
    expect(v.ok && v.prompts[0]?.id).toBeTruthy();
  });

  it.each([
    ['not a list', { prompts: 'x' }, /list of prompts/],
    ['a bad command', [{ command: '/x', name: 'X', template: 'T' }], /lowercase/],
    ['a duplicate', [p('a', 'x'), p('a', 'y')], /used twice/],
    ['no name', [{ command: 'a', name: ' ', template: 'T' }], /no name/],
    ['no template', [{ command: 'a', name: 'A', template: '' }], /no template/],
    ['a huge template', [p('a', 'x'.repeat(5000))], /over 4000/],
  ])('reports %s and accepts nothing', (_what, raw, re) => {
    const v = validatePrompts(raw);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toMatch(re);
  });
});
