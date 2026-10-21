/**
 * Tier-3 parser corpus: 54 model outputs in tests/fixtures/model-outputs.
 *   captured    25  ornith-1.5:9b (Q4_K_M, Ollama 0.40.6), via capture.ts:
 *                   protocol prompts at temp 0 / 0.7 / 1.1, thinking on and off,
 *                   plus 4 prompts without the protocol to provoke leaked formats
 *   handwritten 29  Llama 3.1 8B (7), Qwen3 8B (7), Mistral Nemo 12B (6),
 *                   Gemma 3 12B (5), Phi-4 14B (4)
 * Expectations: 45 calls, 9 specific errors.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatToolCall,
  parseToolCall,
  resolveToolName,
  textProtocolInstructions,
  toolSignature,
} from '@/prompting/tools-fallback';
import { CORPUS_TOOLS as TOOLS } from '../fixtures/model-outputs/tools';

interface CorpusEntry {
  id: string;
  source: 'captured' | 'handwritten';
  model: string;
  raw: string;
  expect: { name: string; args: Record<string, unknown> } | { error: string };
  note?: string;
}

const DIR = resolve(import.meta.dirname, '../fixtures/model-outputs');
const corpus: CorpusEntry[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(DIR, f), 'utf8')) as CorpusEntry);

describe('corpus', () => {
  it('has at least 34 entries, 8+ of them captured from a real model', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(34);
    expect(corpus.filter((c) => c.source === 'captured').length).toBeGreaterThanOrEqual(8);
  });

  it.each(corpus.map((c) => [c.id, c] as const))('%s', (_id, entry) => {
    const result = parseToolCall(entry.raw, TOOLS);
    if ('error' in entry.expect) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(entry.expect.error);
    } else {
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      if (result.ok)
        expect({ name: result.call.name, args: result.call.args }).toEqual(entry.expect);
    }
  });
});

describe('name resolution', () => {
  const ok = (raw: string) => {
    const r = resolveToolName(raw, TOOLS);
    return r.ok ? r.tool.name : r.error;
  };

  it('accepts case, separator and prefix variants', () => {
    expect(ok('switch_tab')).toBe('switchTab');
    expect(ok('switch-tab')).toBe('switchTab');
    expect(ok('SWITCHTAB')).toBe('switchTab');
    expect(ok('default_api.pressKey')).toBe('pressKey');
    expect(ok('functions.ask_user')).toBe('askUser');
    expect(ok('right click')).toBe('rightClick');
  });

  it('accepts a unique one-letter typo on longer names only', () => {
    expect(ok('extrat')).toBe('extract');
    expect(ok('waitfr')).toBe('waitFor');
    // "clik" is too short to guess safely.
    expect(ok('clik')).toMatch(
      /^Unknown action "clik"\. Available actions: navigate, .*\. Did you mean "click"\?$/,
    );
  });

  it('lists the available actions without a hint when nothing is close', () => {
    const err = ok('purchase');
    expect(err).toContain('Unknown action "purchase".');
    expect(err).not.toContain('Did you mean');
    expect(ok('')).toBe('The action has no name. Use <action name="…">.');
  });
});

describe('errors fed back in the repair round', () => {
  const err = (raw: string) => {
    const r = parseToolCall(raw, TOOLS);
    return r.ok ? `ok:${r.call.name}` : r.error;
  };

  it('are specific', () => {
    expect(err('I think we are done here.')).toBe(
      'No action found. Reply with exactly one <action name="…"> block.',
    );
    expect(err('<action>\n<arg name="id">1</arg>\n</action>')).toBe(
      'The <action> tag has no name. Use <action name="…">.',
    );
    expect(err('<action name="click"')).toContain('cut off inside an <action> tag');
    expect(err('<action name="extract">{"schema": {"a": 1,}}</action>')).toMatch(
      /^The action arguments are not valid JSON \(.+\)\.$/,
    );
    expect(err('<tool_call>{"arguments": {"id": 1}}</tool_call>')).toBe(
      'The tool call JSON has no "name".',
    );
    expect(err('<action name="ACTION_NAME"></action>')).toContain('Replace the placeholders');
    expect(err('<thinking>Let me look at all the products in detail and')).toContain(
      'ended inside <thinking>',
    );
  });

  it('prefer a valid later action over an earlier broken one', () => {
    expect(err('<action name="purchase"></action>\n<action name="back"></action>')).toBe('ok:back');
  });
});

describe('python-style calls', () => {
  const call = (raw: string) => {
    const r = parseToolCall(raw, TOOLS);
    if (!r.ok) throw new Error(r.error);
    return r.call;
  };

  it('reads keyword and positional args with Python literals', () => {
    expect(call('type(1, "it\'s \\"quoted\\"", submit=True)')).toMatchObject({
      name: 'type',
      args: { id: 1, text: 'it\'s "quoted"', submit: true },
    });
    expect(
      call("```tool_code\nextract(schema={'items': [1, 2.5, None, False]})\n```").args,
    ).toEqual({
      schema: { items: [1, 2.5, null, false] },
    });
    expect(call('```py\ndone(summary="""Line one\nLine two""")\n```').args).toEqual({
      summary: 'Line one\nLine two',
    });
  });

  it('ignores prose that only looks like a call', () => {
    expect(parseToolCall('You can type (or paste) the text yourself.', TOOLS).ok).toBe(false);
    expect(parseToolCall('Run print(len(x)) to see.', TOOLS).ok).toBe(false);
  });

  it('reports unreadable arguments', () => {
    const r = parseToolCall('```tool_code\nclick(id=element_7)\n```', TOOLS);
    expect(r.ok ? '' : r.error).toMatch(
      /^Could not read the arguments of click\(…\): unexpected "element_7/,
    );
  });
});

describe('thoughts', () => {
  it('come from <thinking>/<think>, or prose before the action', () => {
    const a = parseToolCall(
      '<think>Use search.</think>\n<action name="click"><arg name="id">2</arg></action>',
      TOOLS,
    );
    expect(a.ok && a.call.thought).toBe('Use search.');
    const b = parseToolCall('First I go back.\n<action name="back"></action>', TOOLS);
    expect(b.ok && b.call.thought).toBe('First I go back.');
    const c = parseToolCall('{"thought": "t", "action": "reload", "args": {}}', TOOLS);
    expect(c.ok && c.call.thought).toBe('t');
  });

  it('are capped', () => {
    const r = parseToolCall(
      `<thinking>${'x'.repeat(2000)}</thinking><action name="back"></action>`,
      TOOLS,
    );
    expect(r.ok && r.call.thought?.length).toBe(500);
  });

  it('never yield an action from reasoning when the reply has one outside it', () => {
    const r = parseToolCall(
      '<think><action name="click"><arg name="id">1</arg></action> no wait</think>\n<action name="back"></action>',
      TOOLS,
    );
    expect(r.ok && r.call.name).toBe('back');
  });
});

describe('formatToolCall round-trip', () => {
  const cases = [
    {
      name: 'type',
      args: { id: 3, text: 'Tom & Jerry <3 "quoted" \'single\'\nsecond line', submit: false },
    },
    { name: 'navigate', args: { url: 'https://example.com/?a=1&b=<2>' } },
    {
      name: 'extract',
      args: { schema: { title: 'string', tags: ['a', '<b>'], nested: { n: 1 } } },
    },
    { name: 'scroll', args: { direction: 'down', amount: 2 } },
    { name: 'back', args: {} },
    { name: 'done', args: { summary: 'Price is $899 & ships <today>' } },
  ];

  it.each(cases)('$name', (c) => {
    const r = parseToolCall(formatToolCall(c), TOOLS);
    expect(r.ok && { name: r.call.name, args: r.call.args }).toEqual(c);
    expect(r.ok && r.format).toBe('xml');
  });
});

describe('textProtocolInstructions', () => {
  it('lists every tool with its signature', () => {
    const text = textProtocolInstructions(TOOLS);
    for (const t of TOOLS) expect(text).toContain(toolSignature(t));
    expect(text).toContain('<action name="ACTION_NAME">');
  });

  it('marks optional arguments and renders enums', () => {
    const scroll = TOOLS.find((t) => t.name === 'scroll');
    const type = TOOLS.find((t) => t.name === 'type');
    expect(scroll && toolSignature(scroll)).toBe(
      'scroll(direction?: "up" | "down", id?: integer, amount?: integer) — Scroll the page or an element',
    );
    expect(type && toolSignature(type)).toBe(
      'type(id: integer, text: string, submit?: boolean) — Type text into a field',
    );
  });
});
