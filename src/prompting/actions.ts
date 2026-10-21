/**
 * One-shot actions on a piece of selected text (highlight bubble and
 * context menu). The selection is always passed as fenced untrusted content;
 * the instruction comes only from these templates or the user's own words.
 */

export type QuickAction = 'explain' | 'summarize' | 'translate' | 'improve' | 'ask';

export const QUICK_ACTIONS: { id: QuickAction; label: string }[] = [
  { id: 'explain', label: 'Explain' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'translate', label: 'Translate' },
  { id: 'improve', label: 'Improve' },
  { id: 'ask', label: 'Ask…' },
];

export function quickInstruction(
  action: QuickAction,
  opts: { language: string; question?: string },
): string {
  switch (action) {
    case 'explain':
      return 'Explain the selected text above in plain language. Define any jargon. Be concise.';
    case 'summarize':
      return 'Summarize the selected text above in a few bullet points. Keep the key facts and numbers.';
    case 'translate':
      return `Translate the selected text above into ${opts.language}. Output only the translation.`;
    case 'improve':
      return 'Rewrite the selected text above to be clearer and better written while keeping its meaning and tone. Output only the rewritten text.';
    case 'ask':
      return opts.question?.trim() ? opts.question.trim() : 'What is this about?';
  }
}

/** The language to translate into: the user's setting, else the browser UI language. */
export function translationTarget(setting: string, uiLanguage: string): string {
  if (setting.trim()) return setting.trim();
  try {
    return (
      new Intl.DisplayNames(['en'], { type: 'language' }).of(uiLanguage.split('-')[0] ?? 'en') ??
      'English'
    );
  } catch {
    return 'English';
  }
}
