import { describe, expect, it } from 'vitest';
import {
  buildDecisionRequest,
  decide,
  downgrade,
  interpret,
  selectTier,
  type Completion,
  type ModelRef,
} from '@/agent/harness';
import { runAgent, type AgentEvent, type RunInput } from '@/agent/loop';
import { checkUrl, normalizeAgentUrl } from '@/agent/guard';
import {
  parseJsonLoose,
  shorthandToSchema,
  type AgentContext,
  type TabsApi,
} from '@/agent/tools/execute';
import { READ_ONLY_TOOLS } from '@/agent/tools/specs';
import { memoryTraceSink, redactForTrace } from '@/agent/trace';
import type { PageExtract } from '@/context/extract';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { ChatStreamRequest } from '@/background/chat';
import { DEFAULT_CAPABILITIES, type Capabilities } from '@/providers/types';

const caps = (c: Partial<Capabilities> = {}): Capabilities => ({
  ...DEFAULT_CAPABILITIES,
  contextLength: 8192,
  ...c,
});
const NATIVE: ModelRef = {
  instanceId: 'o',
  model: 'm',
  caps: caps({ nativeTools: true, jsonSchema: true }),
};

const tool = (name: string, args: Record<string, unknown>): Completion => ({
  text: '',
  reasoning: '',
  toolCalls: [{ id: 'c', name, arguments: JSON.stringify(args) }],
});
const text = (t: string): Completion => ({ text: t, reasoning: '', toolCalls: [] });

/** A tiny web: url → page. */
function fakeWeb(pages: Record<string, { title: string; text: string }>) {
  let current = 'https://shop.example/';
  const visits: string[] = [];
  const tabs: TabsApi = {
    navigate: (_id, url) => {
      current = url;
      visits.push(url);
      return Promise.resolve();
    },
    goBack: () => Promise.resolve(),
    create: (_w, url) => {
      current = url;
      visits.push(url);
      return Promise.resolve(2);
    },
    list: () =>
      Promise.resolve([{ id: 1, title: pages[current]?.title ?? '', url: current, active: true }]),
    activate: () => Promise.resolve(),
    waitForLoad: () => Promise.resolve(),
  };
  const readPage = (): Promise<PageExtract> => {
    const p = pages[current];
    if (!p) return Promise.reject(new Error('404'));
    return Promise.resolve({
      url: current,
      title: p.title,
      text: p.text,
      selection: '',
      method: 'body',
      truncated: false,
      hiddenChars: 0,
      hiddenSample: '',
    });
  };
  return { tabs, readPage, visits };
}

function setup(
  script: Completion[],
  opts: Partial<RunInput> = {},
  prefs: Partial<typeof DEFAULT_SETTINGS.agent> = {},
) {
  const web = fakeWeb({
    'https://shop.example/': {
      title: 'Shop',
      text: 'Boots: Ridgeline Pro $189, Granite GTX $159.',
    },
    'https://shop.example/granite': {
      title: 'Granite GTX',
      text: 'Granite GTX — $159 — waterproof.',
    },
  });
  const requests: ChatStreamRequest[] = [];
  const events: AgentEvent[] = [];
  const trace = memoryTraceSink();
  const ctrl = new AbortController();
  const ctx: AgentContext = {
    tabId: 1,
    windowId: 1,
    signal: ctrl.signal,
    policy: { allowDomains: [], blockDomains: [] },
    readPage: web.readPage,
    waitForText: () => Promise.resolve(true),
    complete: () => Promise.resolve('[{"name":"Ridgeline Pro","price":189}]'),
    tabs: web.tabs,
  };
  let i = 0;
  const input: RunInput = {
    runId: 'r1',
    task: 'Find the price of the Granite GTX',
    model: NATIVE,
    tools: READ_ONLY_TOOLS,
    prefs: { ...DEFAULT_SETTINGS.agent, ...prefs },
    ctx,
    complete: (req) => {
      requests.push(req);
      const next = script[i++];
      if (!next) throw new Error('script exhausted');
      return Promise.resolve(next);
    },
    trace,
    emit: (e) => events.push(e),
    ...opts,
  };
  return { input, web, requests, events, trace, ctrl };
}

describe('tier selection', () => {
  it('picks native > constrained > text, honours forcing, and steps down', () => {
    expect(selectTier(caps({ nativeTools: true }))).toBe('native');
    expect(selectTier(caps({ jsonSchema: true }))).toBe('constrained');
    expect(selectTier(caps({ grammar: true }))).toBe('constrained');
    expect(selectTier(caps())).toBe('text');
    expect(selectTier(caps({ nativeTools: true }), 'text')).toBe('text');
    expect(downgrade('native', caps({ jsonSchema: true }))).toBe('constrained');
    expect(downgrade('native', caps())).toBe('text');
    expect(downgrade('constrained', caps())).toBe('text');
    expect(downgrade('text', caps())).toBeNull();
  });

  it('builds tier-specific requests', () => {
    const turn = [{ role: 'user' as const, content: 'go' }];
    const n = buildDecisionRequest('native', NATIVE, READ_ONLY_TOOLS, turn);
    expect(n.tools?.map((t) => t.name)).toContain('navigate');
    const llama = buildDecisionRequest(
      'constrained',
      { ...NATIVE, caps: caps({ grammar: true, jsonSchema: true }) },
      READ_ONLY_TOOLS,
      turn,
    );
    expect(llama.grammar).toMatch(/^root ::=/m);
    expect(llama.responseFormat).toBeUndefined();
    const ollama = buildDecisionRequest(
      'constrained',
      { ...NATIVE, caps: caps({ jsonSchema: true }) },
      READ_ONLY_TOOLS,
      turn,
    );
    expect(ollama.responseFormat).toMatchObject({ type: 'json_schema', name: 'agent_step' });
    const t = buildDecisionRequest(
      'text',
      { ...NATIVE, caps: caps({ thinking: true }) },
      READ_ONLY_TOOLS,
      turn,
    );
    expect(t.messages[0]?.content).toContain('<action name=');
    expect(t.think).toBe(false);
    expect(t.tools).toBeUndefined();
  });
});

describe('interpret', () => {
  it('validates and coerces native calls', () => {
    const r = interpret('native', tool('switchTab', { index: '2' }), READ_ONLY_TOOLS);
    expect(r).toMatchObject({ ok: true, call: { name: 'switchTab', args: { index: 2 } } });
  });

  it('resolves names loosely, rejects unknown tools with the list', () => {
    expect(interpret('native', tool('switch_tab', { index: 0 }), READ_ONLY_TOOLS)).toMatchObject({
      ok: true,
      call: { name: 'switchTab' },
    });
    const bad = interpret('native', tool('purchase', {}), READ_ONLY_TOOLS);
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain('Available actions: navigate');
  });

  it('reports missing arguments specifically', () => {
    const r = interpret('native', tool('navigate', {}), READ_ONLY_TOOLS);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('url');
  });

  it('falls back to parsing text when a native model answers in text', () => {
    const r = interpret(
      'native',
      text('<action name="navigate"><arg name="url">https://a.com</arg></action>'),
      READ_ONLY_TOOLS,
    );
    expect(r).toMatchObject({
      ok: true,
      call: { name: 'navigate', args: { url: 'https://a.com' } },
    });
  });

  it('parses constrained JSON and wraps a non-object done.result', () => {
    const r = interpret(
      'constrained',
      text('{"thought":"got it","action":"done","args":{"summary":"$159","result":[1,2]}}'),
      READ_ONLY_TOOLS,
    );
    expect(r).toMatchObject({
      ok: true,
      call: {
        name: 'done',
        thought: 'got it',
        args: { summary: '$159', result: { value: [1, 2] } },
      },
    });
  });
});

describe('decide with repair', () => {
  it('shows the model its bad reply and the problem once, then succeeds', async () => {
    const replies = [tool('navigate', {}), tool('navigate', { url: 'https://a.com' })];
    const seen: ChatStreamRequest[] = [];
    const d = await decide({
      tier: 'native',
      model: NATIVE,
      tools: READ_ONLY_TOOLS,
      turn: [{ role: 'user', content: 'go' }],
      complete: (req) => {
        seen.push(req);
        return Promise.resolve(replies.shift() ?? text(''));
      },
      signal: new AbortController().signal,
    });
    expect(d.repaired).toBe(true);
    expect(d.result).toMatchObject({ ok: true, call: { args: { url: 'https://a.com' } } });
    const retry = seen[1]?.messages ?? [];
    expect(retry.at(-2)).toMatchObject({ role: 'assistant' });
    expect(retry.at(-1)?.content).toMatch(/could not be used: navigate: .*url/);
  });
});

describe('runAgent', () => {
  it('navigates, reads, and finishes with the answer; every step is traced', async () => {
    const { input, web, events, trace, requests } = setup([
      tool('navigate', { url: 'shop.example/granite' }),
      tool('done', { summary: 'The Granite GTX costs $159.' }),
    ]);
    const r = await runAgent(input);
    expect(r).toMatchObject({
      status: 'done',
      summary: 'The Granite GTX costs $159.',
      steps: 2,
      tier: 'native',
    });
    expect(web.visits).toEqual(['https://shop.example/granite']);
    expect(events[0]).toMatchObject({ type: 'tier', tier: 'native' });
    expect(trace.records.map((t) => t.action)).toEqual(['navigate', 'done']);
    // Step 2 saw the new page and a compact progress line.
    const turn2 = requests[1]?.messages.at(-1)?.content as string;
    expect(turn2).toContain('Granite GTX — $159');
    expect(turn2).toContain(
      'Step 1: navigate(url="https://shop.example/granite") → loaded "Granite GTX"',
    );
    expect(turn2).toContain('<untrusted_page_content');
  });

  it('never feeds the model’s own reasoning back', async () => {
    const { input, requests } = setup([
      {
        ...tool('navigate', { url: 'https://shop.example/granite' }),
        reasoning: 'SECRET-CHAIN-OF-THOUGHT',
      },
      tool('done', { summary: 'ok' }),
    ]);
    await runAgent(input);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('SECRET-CHAIN-OF-THOUGHT');
  });

  it('refuses blocked domains without visiting them and lets the model recover', async () => {
    const { input, web, events } = setup([
      tool('navigate', { url: 'https://www.paypal.com/login' }),
      tool('done', { summary: 'I could not open PayPal.' }),
    ]);
    const r = await runAgent(input);
    expect(web.visits).toEqual([]);
    const step = events.find((e) => e.type === 'step');
    expect(step).toMatchObject({ step: { outcome: 'blocked' } });
    expect(r.status).toBe('done');
  });

  it('fails after the consecutive-invalid budget, without burning real steps on tools', async () => {
    const bad = text('I think the answer is probably $159.');
    const { input } = setup([bad, bad, bad, bad, bad, bad], {}, { maxConsecutiveFailures: 3 });
    const r = await runAgent(input);
    expect(r.status).toBe('failed');
    expect(r.summary).toContain('3 times in a row');
  });

  it('stops at the step limit', async () => {
    const { input } = setup(
      Array.from({ length: 4 }, () => tool('waitFor', { condition: 'Boots' })),
      {},
      { maxSteps: 4 },
    );
    expect(await runAgent(input)).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('step limit (4)') as string,
    });
  });

  it('ends with needs-user on askUser', async () => {
    const { input } = setup([tool('askUser', { question: 'Which size?' })]);
    expect(await runAgent(input)).toMatchObject({ status: 'needs-user', summary: 'Which size?' });
  });

  it('stops when aborted', async () => {
    const s = setup([tool('waitFor', { condition: 'x' })]);
    s.ctrl.abort(new DOMException('stop', 'AbortError'));
    expect(await runAgent(s.input)).toMatchObject({ status: 'stopped' });
  });

  it('drops to the constrained tier when native tools are rejected', async () => {
    let first = true;
    const { input, events } = setup([], {
      model: { ...NATIVE },
      complete: (req) => {
        if (first) {
          first = false;
          return Promise.reject(
            Object.assign(new Error('no tools'), { code: 'E_TOOLS_UNSUPPORTED' }),
          );
        }
        expect(req.tools).toBeUndefined();
        return Promise.resolve(text('{"thought":"done","action":"done","args":{"summary":"ok"}}'));
      },
    });
    const r = await runAgent(input);
    expect(r).toMatchObject({ status: 'done', tier: 'constrained', steps: 1 });
    expect(
      events.filter((e) => e.type === 'tier').map((e) => (e as { tier: string }).tier),
    ).toEqual(['native', 'constrained']);
  });

  it('extract returns structured data into the log', async () => {
    const { input, requests } = setup([
      tool('extract', { schema: { name: 'string', price: 'number' } }),
      tool('done', { summary: 'listed' }),
    ]);
    await runAgent(input);
    expect(requests[1]?.messages.at(-1)?.content).toContain('extracted');
    expect(requests[1]?.messages.at(-1)?.content).toContain('Ridgeline Pro');
  });
});

describe('guard', () => {
  const p = { allowDomains: [], blockDomains: [] };
  it.each([
    ['https://www.chase.com/', false],
    ['https://secure.onlinebanking.example.com/', false],
    ['https://www.irs.gov/forms', false],
    ['https://www.gov.uk/', false],
    ['https://mail.google.com/mail', false],
    ['https://www.paypal.com/', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['https://news.ycombinator.com/', true],
    ['https://databank.example.org/', true],
    ['http://127.0.0.1:5173/', true],
  ])('%s → allowed=%s', (url, allowed) => {
    expect(checkUrl(url, p).allowed).toBe(allowed);
  });
  it('user allow overrides a default rule; user block always wins', () => {
    expect(
      checkUrl('https://www.paypal.com/', { allowDomains: ['paypal.com'], blockDomains: [] })
        .allowed,
    ).toBe(true);
    expect(
      checkUrl('https://news.ycombinator.com/', {
        allowDomains: [],
        blockDomains: ['ycombinator.com'],
      }).allowed,
    ).toBe(false);
  });
  it('normalizes bare domains', () => {
    expect(normalizeAgentUrl('example.com/a')).toBe('https://example.com/a');
    expect(normalizeAgentUrl('http://x.test')).toBe('http://x.test');
  });
});

describe('extract helpers', () => {
  it('turns shorthand into JSON Schema', () => {
    expect(shorthandToSchema({ name: 'string', price: 'number' })).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, price: { type: 'number' } },
    });
    expect(shorthandToSchema([{ name: 'string' }])).toMatchObject({
      type: 'array',
      items: { type: 'object' },
    });
    expect(shorthandToSchema({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(shorthandToSchema({ when: 'date of the event' })).toEqual({
      type: 'object',
      properties: { when: { type: 'string', description: 'date of the event' } },
    });
  });
  it('parses JSON from chatty replies', () => {
    expect(parseJsonLoose('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('[1,2]')).toEqual([1, 2]);
    expect(() => parseJsonLoose('no json')).toThrow();
  });
  it('redacts card numbers, SSNs and tokens in traces', () => {
    expect(
      redactForTrace({
        text: 'card 4242 4242 4242 4242, ssn 123-45-6789, key sk-live_abcdefgh123',
      }),
    ).toEqual({
      text: 'card [card], ssn [ssn], key [token]',
    });
  });
});
