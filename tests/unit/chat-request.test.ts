import { describe, expect, it } from 'vitest';
import { buildRequest, estimateTokens, type BuildInput } from '@/chat/request';
import type { ConversationRecord, MessageRecord } from '@/lib/db';
import { DEFAULT_SETTINGS, hostMatches, matchSiteRule, migrate } from '@/lib/settings';

const conv: ConversationRecord = {
  id: 'c',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  pinned: 0,
  instanceId: 'ollama',
  model: 'qwen3:8b',
  activeLeafId: null,
  settings: {},
};

let t = 0;
function msg(
  role: MessageRecord['role'],
  content: string,
  extra: Partial<MessageRecord> = {},
): MessageRecord {
  t += 1;
  return {
    id: `m${t}`,
    conversationId: 'c',
    parentId: null,
    role,
    content,
    createdAt: t,
    ...extra,
  };
}

function input(thread: MessageRecord[], extra: Partial<BuildInput> = {}): BuildInput {
  return {
    conversation: conv,
    thread,
    defaults: DEFAULT_SETTINGS.generation,
    systemPrompt: 'SYS',
    reasoning: 'auto',
    modelThinks: true,
    contextLength: 32768,
    ...extra,
  };
}

describe('buildRequest', () => {
  it('never sends reasoning, skips errors and empty replies', () => {
    const { request } = buildRequest(
      input([
        msg('user', 'q1'),
        msg('assistant', 'a1', { reasoning: 'SECRET THOUGHTS' }),
        msg('user', 'q2'),
        msg('assistant', '', { status: 'error', error: { message: 'boom' } }),
        msg('assistant', 'partial', { status: 'error' }),
        msg('user', 'q3'),
      ]),
    );
    expect(request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
    ]);
    expect(JSON.stringify(request)).not.toContain('SECRET');
  });

  it('applies per-conversation overrides and generation defaults', () => {
    const { request } = buildRequest(
      input([msg('user', 'hi')], {
        conversation: {
          ...conv,
          settings: { systemPrompt: 'Be terse.', temperature: 0.1, maxTokens: 99 },
        },
        defaults: { ...DEFAULT_SETTINGS.generation, seed: 42, numCtx: 4096 },
      }),
    );
    expect(request.messages[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(request.options).toEqual({
      temperature: 0.1,
      topP: 0.9,
      maxTokens: 99,
      numCtx: 4096,
      seed: 42,
    });
  });

  it('omits seed when random, num_ctx when 0, and clamps num_ctx to the model', () => {
    const r1 = buildRequest(
      input([msg('user', 'x')], { defaults: { ...DEFAULT_SETTINGS.generation, numCtx: 0 } }),
    );
    expect(r1.request.options).not.toHaveProperty('seed');
    expect(r1.request.options).not.toHaveProperty('numCtx');
    const r2 = buildRequest(input([msg('user', 'x')], { contextLength: 2048 }));
    expect(r2.request.options?.numCtx).toBe(2048);
  });

  it('maps the reasoning mode only for thinking models', () => {
    expect(buildRequest(input([msg('user', 'x')], { reasoning: 'on' })).request.think).toBe(true);
    expect(buildRequest(input([msg('user', 'x')], { reasoning: 'off' })).request.think).toBe(false);
    expect(buildRequest(input([msg('user', 'x')])).request).not.toHaveProperty('think');
    expect(
      buildRequest(input([msg('user', 'x')], { reasoning: 'on', modelThinks: false })).request,
    ).not.toHaveProperty('think');
  });

  it('drops the oldest turns to fit, never the system prompt or the last user turn', () => {
    const big = 'word '.repeat(2000); // ~2.9k tokens each
    const thread = [
      msg('user', big),
      msg('assistant', big),
      msg('user', big),
      msg('assistant', big),
      msg('user', 'final question'),
    ];
    const { request, dropped } = buildRequest(
      input(thread, {
        defaults: { ...DEFAULT_SETTINGS.generation, numCtx: 8192, maxTokens: 2048 },
      }),
    );
    expect(dropped).toBeGreaterThan(0);
    expect(request.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'final question' });
    expect(request.messages[1]?.role).toBe('user');
    const total = request.messages.reduce((n, m) => n + estimateTokens(m.content as string), 0);
    expect(total).toBeLessThanOrEqual(8192 - 2048);
  });

  it('keeps a lone oversized user message rather than sending nothing', () => {
    const { request } = buildRequest(
      input([msg('user', 'x'.repeat(200_000))], { contextLength: 4096 }),
    );
    expect(request.messages.at(-1)?.role).toBe('user');
  });
});

describe('site rules', () => {
  it('matches hosts and wildcard subdomains', () => {
    expect(hostMatches('github.com', 'github.com')).toBe(true);
    expect(hostMatches('github.com', 'www.github.com')).toBe(true);
    expect(hostMatches('github.com', 'gist.github.com')).toBe(false);
    expect(hostMatches('*.github.com', 'gist.github.com')).toBe(true);
    expect(hostMatches('*.github.com', 'github.com')).toBe(true);
    expect(hostMatches('https://GitHub.com/foo', 'github.com')).toBe(true);
    expect(hostMatches('', 'x.com')).toBe(false);
  });

  it('picks the first matching rule for a URL', () => {
    const rules = [
      { pattern: 'github.com', instanceId: 'ollama', model: 'qwen3-coder' },
      { pattern: '*.com', instanceId: 'ollama', model: 'llama3.2' },
    ];
    expect(matchSiteRule(rules, 'https://github.com/x/y')?.model).toBe('qwen3-coder');
    expect(matchSiteRule(rules, 'https://news.example.com')?.model).toBe('llama3.2');
    expect(matchSiteRule(rules, 'chrome://newtab')).toBeUndefined();
    expect(matchSiteRule(rules, undefined)).toBeUndefined();
  });

  it('settings migrate in the new chat fields and reject bad values', () => {
    const s = migrate({
      schemaVersion: 1,
      reasoning: 'maybe',
      siteRules: [{ pattern: 'a.com' }, { pattern: 'b.com', instanceId: 'o', model: 'm' }],
    });
    expect(s.reasoning).toBe('auto');
    expect(s.siteRules).toEqual([{ pattern: 'b.com', instanceId: 'o', model: 'm' }]);
    expect(s.generation).toEqual(DEFAULT_SETTINGS.generation);
    expect(s.chat).toEqual({ enterToSend: true, showReasoning: false });
  });
});
