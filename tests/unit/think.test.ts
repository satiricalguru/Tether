import { describe, expect, it } from 'vitest';
import { ThinkSplitter } from '@/providers/think';
import type { ChatChunk } from '@/providers/types';

/** Feed `text` in pieces of `size` chars and fold the result like the UI would. */
function run(text: string, size: number): { text: string; reasoning: string } {
  const s = new ThinkSplitter();
  const out: ChatChunk[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.flush());
  let visible = '';
  let reasoning = '';
  for (const c of out) {
    if (c.type === 'text') visible += c.text;
    else if (c.type === 'reasoning') reasoning += c.text;
    else if (c.type === 'reclassify-reasoning') {
      reasoning += visible;
      visible = '';
    }
  }
  return { text: visible, reasoning };
}

const CASES: [string, string, { text: string; reasoning: string }][] = [
  ['plain text passes through', 'Just an answer.', { text: 'Just an answer.', reasoning: '' }],
  [
    'tagged reasoning',
    '<think>\nweighing options\n</think>\n\nFinal answer.',
    { text: 'Final answer.', reasoning: 'weighing options\n' },
  ],
  [
    '<thinking> variant, case-insensitive',
    '  <THINKING>hmm</Thinking>Done',
    { text: 'Done', reasoning: 'hmm' },
  ],
  [
    'untagged reasoning closed later',
    'Okay, the user asks.\n</think>\n\nThe answer is 4.',
    { text: 'The answer is 4.', reasoning: 'Okay, the user asks.\n' },
  ],
  [
    'tags mentioned inside an ordinary answer are left alone once reasoning is done',
    '<think>x</think>Use <think> tags like </think> this.',
    { text: 'Use <think> tags like </think> this.', reasoning: 'x' },
  ],
  [
    'an opening tag after visible text is just text',
    'Here is HTML: <think> is not a real tag',
    { text: 'Here is HTML: <think> is not a real tag', reasoning: '' },
  ],
  [
    'unterminated reasoning stays reasoning',
    '<think>still going',
    { text: '', reasoning: 'still going' },
  ],
  [
    'a lone partial tag at the end is flushed as text',
    'a < b and b <thi',
    { text: 'a < b and b <thi', reasoning: '' },
  ],
  ['empty input', '', { text: '', reasoning: '' }],
];

describe('ThinkSplitter', () => {
  it.each(CASES)('%s (whole)', (_name, input, expected) => {
    expect(run(input, Math.max(1, input.length))).toEqual(expected);
  });

  it.each(CASES)('%s (every chunk size)', (_name, input, expected) => {
    for (let size = 1; size <= Math.max(1, input.length); size++) {
      expect(run(input, size)).toEqual(expected);
    }
  });
});
