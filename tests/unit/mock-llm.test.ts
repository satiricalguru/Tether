// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  mockEmbedding,
  startMockLlm,
  tokenize,
  type MockOptions,
  type MockServer,
} from '../fixtures/mock-llm/server';

const servers: MockServer[] = [];

async function start(opts: MockOptions): Promise<MockServer> {
  const s = await startMockLlm({ tokenDelayMs: 1, ...opts });
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

type Json = Record<string, unknown>;

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as Json };
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Read the whole body as text; resolves `{text, error}` so disconnects are observable. */
async function readAll(res: Response): Promise<{ text: string; error?: unknown }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
  return { text };
}

function ndjson(text: string): Json[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Json);
}

function sse(text: string): (Json | '[DONE]')[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice(6))
    .map((d) => (d === '[DONE]' ? '[DONE]' : (JSON.parse(d) as Json)));
}

interface OllamaLine {
  message?: { content?: string; thinking?: string; tool_calls?: unknown[] };
  done?: boolean;
  error?: string;
  eval_count?: number;
  load_duration?: number;
}

interface OaiChunk {
  choices: {
    delta: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function: { name?: string; arguments?: string };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  timings?: { predicted_n: number; predicted_per_second: number };
  error?: { message: string };
}

const chatBody = (model: string, extra: Json = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Say hello please' }],
  ...extra,
});

const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

describe('helpers', () => {
  it('tokenizes keeping whitespace', () => {
    expect(tokenize('a  b c').join('')).toBe('a  b c');
  });
  it('embeds deterministically to unit bag-of-words vectors', () => {
    const a = mockEmbedding('hello');
    expect(a).toHaveLength(64);
    expect(mockEmbedding('hello')).toEqual(a);
    expect(mockEmbedding('world')).not.toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    // Shared words make texts similar: what retrieval tests rely on.
    const dot = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * (y[i] ?? 0), 0);
    const q = mockEmbedding('parking permit fee');
    expect(dot(q, mockEmbedding('The parking permit fee is $20.'))).toBeGreaterThan(
      dot(q, mockEmbedding('Trail conditions are good today.')),
    );
  });
});

describe('ollama flavor', () => {
  const models = [
    { id: 'llama3.2:3b', loaded: true, tools: true, contextLength: 131072, params: '3.2B' },
    { id: 'qwen3-think:8b', thinking: true, tools: true },
    { id: 'mock-cold', tools: true },
    { id: 'mock-slow', loaded: true },
    { id: 'mock-disconnect', loaded: true },
    { id: 'mock-notools', loaded: true },
    { id: 'mock-toolcall', loaded: true, tools: true },
    { id: 'mock-error', loaded: true },
    { id: 'llava:7b', vision: true },
    { id: 'nomic-embed-text', embedding: true },
  ];

  it('serves root, version, tags, ps and show', async () => {
    const s = await start({ flavor: 'ollama', models });
    expect(await (await fetch(s.url)).text()).toBe('Ollama is running');
    expect((await getJson(`${s.url}/api/version`)).body).toEqual({ version: '0.12.6' });

    const tags = (await getJson(`${s.url}/api/tags`)).body as {
      models: { name: string; details: { parameter_size: string; quantization_level: string } }[];
    };
    expect(tags.models.map((m) => m.name)).toContain('llama3.2:3b');
    expect(tags.models[0]?.details.parameter_size).toBe('3.2B');

    const ps = (await getJson(`${s.url}/api/ps`)).body as {
      models: { name: string; context_length: number; size_vram: number; expires_at: string }[];
    };
    const names = ps.models.map((m) => m.name);
    expect(names).toContain('llama3.2:3b');
    expect(names).not.toContain('mock-cold');
    expect(ps.models[0]).toHaveProperty('size_vram');
    expect(ps.models[0]).toHaveProperty('expires_at');

    const show = (await getJson(`${s.url}/api/show`, post({ model: 'llama3.2:3b' }))).body;
    expect(show.capabilities).toEqual(['completion', 'tools']);
    expect((show.model_info as Json)['llama.context_length']).toBe(131072);
    expect((show.details as Json).quantization_level).toBe('Q4_K_M');

    const vision = (await getJson(`${s.url}/api/show`, post({ model: 'llava:7b' }))).body;
    expect(vision.capabilities).toContain('vision');
    const thinking = (await getJson(`${s.url}/api/show`, post({ model: 'qwen3-think:8b' }))).body;
    expect(thinking.capabilities).toContain('thinking');
    const embed = (await getJson(`${s.url}/api/show`, post({ model: 'nomic-embed-text' }))).body;
    expect(embed.capabilities).toEqual(['embedding']);

    const missing = await getJson(`${s.url}/api/show`, post({ model: 'nope' }));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("model 'nope' not found");
  });

  it('streams NDJSON chat ending with done stats', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'one two three' });
    const res = await fetch(`${s.url}/api/chat`, post(chatBody('llama3.2:3b')));
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = ndjson((await readAll(res)).text) as OllamaLine[];
    const content = lines.map((l) => l.message?.content ?? '').join('');
    expect(content).toBe('one two three');
    const last = lines.at(-1) as Json;
    expect(last).toMatchObject({ done: true, done_reason: 'stop', eval_count: 3 });
    for (const k of [
      'total_duration',
      'load_duration',
      'prompt_eval_count',
      'prompt_eval_duration',
      'eval_duration',
    ]) {
      expect(typeof last[k]).toBe('number');
    }
    expect(s.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/chat' });
  });

  it('supports stream:false', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'hi there' });
    const { body } = await getJson(
      `${s.url}/api/chat`,
      post(chatBody('llama3.2:3b', { stream: false })),
    );
    expect(body).toMatchObject({ done: true, message: { role: 'assistant', content: 'hi there' } });
  });

  it('404s unknown chat models', async () => {
    const s = await start({ flavor: 'ollama', models });
    const res = await getJson(`${s.url}/api/chat`, post(chatBody('ghost')));
    expect(res.status).toBe(404);
  });

  it('emits a complete tool call in one chunk', async () => {
    const s = await start({ flavor: 'ollama', models });
    const res = await fetch(`${s.url}/api/chat`, post(chatBody('mock-toolcall', { tools: TOOLS })));
    const lines = ndjson((await readAll(res)).text) as OllamaLine[];
    expect(lines[0]?.message?.tool_calls).toEqual([
      { function: { name: 'lookup', arguments: { id: 3 } } },
    ]);
    expect(lines.at(-1)?.done).toBe(true);
  });

  it('rejects tools with 400 for notools models', async () => {
    const s = await start({ flavor: 'ollama', models });
    const res = await getJson(
      `${s.url}/api/chat`,
      post(chatBody('mock-notools', { tools: TOOLS })),
    );
    expect(res).toEqual({ status: 400, body: { error: 'tools not supported' } });
    // Without tools it works.
    const ok = await fetch(`${s.url}/api/chat`, post(chatBody('mock-notools')));
    expect(ok.status).toBe(200);
    await readAll(ok);
  });

  it('separates thinking when think:true, inlines <think> otherwise', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'answer' });
    const sep = ndjson(
      (
        await readAll(
          await fetch(`${s.url}/api/chat`, post(chatBody('qwen3-think:8b', { think: true }))),
        )
      ).text,
    ) as OllamaLine[];
    expect(sep.map((l) => l.message?.thinking ?? '').join('')).toBe('Let me think.');
    expect(sep.map((l) => l.message?.content ?? '').join('')).toBe('answer');

    const inline = ndjson(
      (await readAll(await fetch(`${s.url}/api/chat`, post(chatBody('qwen3-think:8b'))))).text,
    ) as OllamaLine[];
    expect(inline.map((l) => l.message?.content ?? '').join('')).toBe(
      '<think>Let me think.</think>answer',
    );
  });

  it('sends a mid-stream error line', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'a b c d e' });
    const lines = ndjson(
      (await readAll(await fetch(`${s.url}/api/chat`, post(chatBody('mock-error'))))).text,
    ) as OllamaLine[];
    expect(lines.at(-1)).toEqual({ error: 'model crashed' });
    expect(lines.some((l) => l.done)).toBe(false);
  });

  it('disconnects mid-stream without a done line', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'a b c d e f' });
    const res = await fetch(`${s.url}/api/chat`, post(chatBody('mock-disconnect')));
    const { text, error } = await readAll(res);
    expect(error).toBeDefined();
    const lines = ndjson(text) as OllamaLine[];
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.done)).toBe(false);
  });

  it('delays the first token for slow models', async () => {
    const s = await start({ flavor: 'ollama', models });
    const t0 = Date.now();
    const res = await fetch(`${s.url}/api/chat`, post(chatBody('mock-slow')));
    const reader = res.body!.getReader();
    await reader.read();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    await reader.cancel();
  });

  it('cold models load on first request and then appear in /api/ps', async () => {
    const s = await start({ flavor: 'ollama', models });
    const before = (await getJson(`${s.url}/api/ps`)).body as { models: { name: string }[] };
    expect(before.models.map((m) => m.name)).not.toContain('mock-cold');
    const t0 = Date.now();
    const lines = ndjson(
      (await readAll(await fetch(`${s.url}/api/chat`, post(chatBody('mock-cold'))))).text,
    ) as OllamaLine[];
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2400);
    expect(lines.at(-1)?.load_duration).toBeGreaterThanOrEqual(2.5e9);
    const after = (await getJson(`${s.url}/api/ps`)).body as { models: { name: string }[] };
    expect(after.models.map((m) => m.name)).toContain('mock-cold');
  });

  it('embeds string and array input', async () => {
    const s = await start({ flavor: 'ollama', models });
    const one = (
      await getJson(`${s.url}/api/embed`, post({ model: 'nomic-embed-text', input: 'x' }))
    ).body;
    expect(one.embeddings as number[][]).toHaveLength(1);
    const many = (
      await getJson(`${s.url}/api/embed`, post({ model: 'nomic-embed-text', input: ['a', 'b'] }))
    ).body;
    expect(many.embeddings).toEqual([mockEmbedding('a'), mockEmbedding('b')]);
  });

  it('unloads via /api/generate keep_alive:0', async () => {
    const s = await start({ flavor: 'ollama', models });
    const res = (
      await getJson(`${s.url}/api/generate`, post({ model: 'llama3.2:3b', keep_alive: 0 }))
    ).body;
    expect(res).toMatchObject({ done: true, done_reason: 'unload' });
    const ps = (await getJson(`${s.url}/api/ps`)).body as { models: { name: string }[] };
    expect(ps.models.map((m) => m.name)).not.toContain('llama3.2:3b');
  });

  it('also serves the OpenAI-compatible path', async () => {
    const s = await start({ flavor: 'ollama', models, reply: 'compat ok' });
    const list = (await getJson(`${s.url}/v1/models`)).body as { data: { id: string }[] };
    expect(list.data.map((m) => m.id)).toContain('llama3.2:3b');
    const res = await fetch(
      `${s.url}/v1/chat/completions`,
      post(chatBody('llama3.2:3b', { stream: true })),
    );
    const events = sse((await readAll(res)).text);
    expect(events.at(-1)).toBe('[DONE]');
    const text = (events.filter((e) => e !== '[DONE]') as unknown as OaiChunk[])
      .map((e) => e.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('compat ok');
  });

  describe('origin rejection', () => {
    it('403s with an empty body for disallowed origins', async () => {
      const s = await start({
        flavor: 'ollama',
        models,
        rejectOrigins: true,
        allowedOrigins: ['chrome-extension://xyz'],
      });
      const res = await fetch(`${s.url}/api/tags`, {
        headers: { origin: 'chrome-extension://abc' },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('');
      const ok = await fetch(`${s.url}/api/tags`, {
        headers: { origin: 'chrome-extension://xyz' },
      });
      expect(ok.status).toBe(200);
      // No Origin header at all (curl) is allowed, like real Ollama.
      expect((await fetch(`${s.url}/api/tags`)).status).toBe(200);
    });

    it('accepts wildcard patterns', async () => {
      const s = await start({
        flavor: 'ollama',
        models,
        rejectOrigins: true,
        allowedOrigins: ['chrome-extension://*'],
      });
      const res = await fetch(`${s.url}/api/version`, {
        headers: { origin: 'chrome-extension://abc' },
      });
      expect(res.status).toBe(200);
      const web = await fetch(`${s.url}/api/version`, {
        headers: { origin: 'https://evil.example' },
      });
      expect(web.status).toBe(403);
    });
  });
});

describe('openai flavor (vLLM-like)', () => {
  it('lists models and version', async () => {
    const s = await start({ flavor: 'openai' });
    const list = (await getJson(`${s.url}/v1/models`)).body as {
      object: string;
      data: { id: string; owned_by: string; max_model_len: number }[];
    };
    expect(list.object).toBe('list');
    expect(list.data[0]).toMatchObject({
      id: 'Qwen/Qwen2.5-7B-Instruct',
      owned_by: 'mock',
      max_model_len: 32768,
    });
    expect((await getJson(`${s.url}/version`)).body).toEqual({ version: '0.11.0' });
  });

  it('streams SSE with a finish chunk, optional usage chunk and [DONE]', async () => {
    const s = await start({ flavor: 'openai', reply: 'x y' });
    const res = await fetch(
      `${s.url}/v1/chat/completions`,
      post(chatBody('m', { stream: true, stream_options: { include_usage: true } })),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = sse((await readAll(res)).text);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1) as unknown as OaiChunk[];
    expect(chunks[0]?.choices[0]?.delta).toMatchObject({ role: 'assistant', content: 'x ' });
    const usage = chunks.at(-1)!;
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toMatchObject({ completion_tokens: 2 });
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');

    const noUsage = sse(
      (
        await readAll(
          await fetch(`${s.url}/v1/chat/completions`, post(chatBody('m', { stream: true }))),
        )
      ).text,
    ) as unknown as OaiChunk[];
    expect(noUsage.some((c) => typeof c === 'object' && 'usage' in c)).toBe(false);
  });

  it('returns a chat.completion object without stream', async () => {
    const s = await start({ flavor: 'openai', reply: 'full' });
    const { body } = await getJson(
      `${s.url}/v1/chat/completions`,
      post(chatBody('m', { response_format: { type: 'json_object' } })),
    );
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'full' }, finish_reason: 'stop' }],
    });
    expect(body.usage).toBeDefined();
    expect((s.requests.at(-1)?.body as Json).response_format).toEqual({ type: 'json_object' });
  });

  it('streams tool calls as split argument deltas', async () => {
    const s = await start({ flavor: 'openai' });
    const events = sse(
      (
        await readAll(
          await fetch(
            `${s.url}/v1/chat/completions`,
            post(chatBody('m-toolcall', { stream: true, tools: TOOLS })),
          ),
        )
      ).text,
    );
    const chunks = events.filter((e) => e !== '[DONE]') as unknown as OaiChunk[];
    const deltas = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas[0]).toMatchObject({
      index: 0,
      id: 'call_1',
      function: { name: 'lookup', arguments: '' },
    });
    expect(deltas.map((d) => d.function.arguments ?? '').join('')).toBe('{"id": 3}');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('400s on tools for notools models in OpenAI error shape', async () => {
    const s = await start({ flavor: 'openai' });
    const res = await getJson(
      `${s.url}/v1/chat/completions`,
      post(chatBody('x-notools', { stream: true, tools: TOOLS })),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      message: 'tools is not supported for this model',
      type: 'invalid_request_error',
    });
  });

  it('400s on stream_options for nousage models', async () => {
    const s = await start({ flavor: 'openai' });
    const res = await getJson(
      `${s.url}/v1/chat/completions`,
      post(chatBody('x-nousage', { stream: true, stream_options: { include_usage: true } })),
    );
    expect(res.status).toBe(400);
    expect((res.body.error as Json).message).toBe('Unrecognized request argument: stream_options');
    const ok = await fetch(
      `${s.url}/v1/chat/completions`,
      post(chatBody('x-nousage', { stream: true })),
    );
    expect(ok.status).toBe(200);
    await readAll(ok);
  });

  it('streams reasoning_content for think models', async () => {
    const s = await start({ flavor: 'openai', reply: 'done' });
    const chunks = sse(
      (
        await readAll(
          await fetch(`${s.url}/v1/chat/completions`, post(chatBody('m-think', { stream: true }))),
        )
      ).text,
    ).filter((e) => e !== '[DONE]') as unknown as OaiChunk[];
    expect(chunks.map((c) => c.choices[0]?.delta.reasoning_content ?? '').join('')).toBe(
      'Let me think.',
    );
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('done');
  });

  it('sends a mid-stream SSE error without [DONE]', async () => {
    const s = await start({ flavor: 'openai', reply: 'a b c d' });
    const events = sse(
      (
        await readAll(
          await fetch(`${s.url}/v1/chat/completions`, post(chatBody('m-error', { stream: true }))),
        )
      ).text,
    );
    expect(events).not.toContain('[DONE]');
    expect((events.at(-1) as unknown as OaiChunk).error?.message).toBe('model crashed');
  });

  it('disconnects mid-stream', async () => {
    const s = await start({ flavor: 'openai', reply: 'a b c d e f' });
    const { text, error } = await readAll(
      await fetch(`${s.url}/v1/chat/completions`, post(chatBody('m-disconnect', { stream: true }))),
    );
    expect(error).toBeDefined();
    const events = sse(text);
    expect(events).not.toContain('[DONE]');
    expect(events).toHaveLength(3);
  });

  it('requires the API key when configured', async () => {
    const s = await start({ flavor: 'openai', apiKey: 'secret' });
    const denied = await getJson(`${s.url}/v1/models`);
    expect(denied.status).toBe(401);
    expect((denied.body.error as Json).message).toBe('Invalid API key');
    const ok = await getJson(`${s.url}/v1/models`, { headers: { authorization: 'Bearer secret' } });
    expect(ok.status).toBe(200);
  });

  it('embeds', async () => {
    const s = await start({ flavor: 'openai' });
    const { body } = await getJson(
      `${s.url}/v1/embeddings`,
      post({ model: 'e', input: ['a', 'b'] }),
    );
    expect(body.data).toEqual([
      { object: 'embedding', embedding: mockEmbedding('a'), index: 0 },
      { object: 'embedding', embedding: mockEmbedding('b'), index: 1 },
    ]);
    expect(body.usage).toBeDefined();
  });

  it('404s unknown endpoints in OpenAI shape', async () => {
    const s = await start({ flavor: 'openai' });
    const res = await getJson(`${s.url}/v1/nope`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('records requests with headers and parsed bodies', async () => {
    const s = await start({ flavor: 'openai' });
    await getJson(`${s.url}/v1/chat/completions`, post(chatBody('m'), { 'x-test': '1' }));
    expect(s.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'x-test': '1' },
      body: { model: 'm' },
    });
  });
});

describe('lmstudio flavor', () => {
  it('serves /api/v0/models with state, type, quant and context', async () => {
    const s = await start({ flavor: 'lmstudio' });
    const { body } = await getJson(`${s.url}/api/v0/models`);
    const data = body.data as Json[];
    expect(data.find((m) => m.id === 'qwen2.5-7b-instruct')).toMatchObject({
      type: 'llm',
      state: 'loaded',
      quantization: 'Q4_K_M',
      max_context_length: 32768,
      compatibility_type: 'gguf',
      capabilities: ['tool_use'],
    });
    expect(data.find((m) => m.id === 'gemma-3-12b-it')).toMatchObject({
      type: 'vlm',
      state: 'not-loaded',
    });
    expect(data.find((m) => String(m.id).includes('embed'))).toMatchObject({
      type: 'embeddings',
    });
    expect((await getJson(`${s.url}/v1/models`)).status).toBe(200);
  });

  it('cold models report not-loaded until the first request loads them', async () => {
    const s = await start({ flavor: 'lmstudio', models: [{ id: 'big-cold' }] });
    const state = async () =>
      ((await getJson(`${s.url}/api/v0/models`)).body.data as { state: string }[])[0]?.state;
    expect(await state()).toBe('not-loaded');
    const t0 = Date.now();
    await readAll(
      await fetch(`${s.url}/v1/chat/completions`, post(chatBody('big-cold', { stream: true }))),
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2400);
    expect(await state()).toBe('loaded');
  });
});

describe('llamacpp flavor', () => {
  it('serves /health and /props', async () => {
    const s = await start({ flavor: 'llamacpp' });
    expect((await getJson(`${s.url}/health`)).body).toEqual({ status: 'ok' });
    const props = (await getJson(`${s.url}/props`)).body;
    expect(props).toMatchObject({
      default_generation_settings: { n_ctx: 8192 },
      total_slots: 1,
      model_path: '/models/mock.gguf',
      modalities: { vision: false },
      build_info: 'b6500-mock',
    });
    expect(props.chat_template).toContain('tools');
  });

  it('adds timings to the final chunk and accepts grammar / json_schema', async () => {
    const s = await start({ flavor: 'llamacpp', reply: 'a b c' });
    const chunks = sse(
      (
        await readAll(
          await fetch(
            `${s.url}/v1/chat/completions`,
            post(
              chatBody('anything', {
                stream: true,
                grammar: 'root ::= "a"',
                json_schema: { type: 'object' },
              }),
            ),
          ),
        )
      ).text,
    ).filter((e) => e !== '[DONE]') as unknown as OaiChunk[];
    const final = chunks.at(-1)!;
    expect(final.choices[0]?.finish_reason).toBe('stop');
    expect(final.timings?.predicted_n).toBe(3);
    expect(final.timings?.predicted_per_second).toBeGreaterThan(0);
    expect(s.requests.at(-1)?.body).toMatchObject({ grammar: 'root ::= "a"' });
  });

  it('does not serve other flavours’ native endpoints', async () => {
    const s = await start({ flavor: 'llamacpp' });
    expect((await fetch(`${s.url}/api/tags`)).status).toBe(404);
    expect((await fetch(`${s.url}/api/v0/models`)).status).toBe(404);
  });
});
