import { describe, expect, it } from 'vitest';
import { ProviderError } from '@/providers/http';
import { llamaCapabilities } from '@/providers/llamacpp';
import { lmsCapabilities } from '@/providers/lmstudio';
import { buildOllamaBody, canonicalOllamaName, capabilitiesFromShow } from '@/providers/ollama';
import { buildOpenAIBody, isToolsRejection, toOpenAIMessages } from '@/providers/openai-core';
import type { ChatChunk, ChatRequest } from '@/providers/types';
import { json, makeProvider } from '../helpers/fake-fetch';
import { collect, fixtureBytes, streamResponse } from '../helpers/streams';

const signal = () => new AbortController().signal;
const REQ: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function textOf(chunks: ChatChunk[]): string {
  return chunks.map((c) => (c.type === 'text' ? c.text : '')).join('');
}
function reasoningOf(chunks: ChatChunk[]): string {
  return chunks.map((c) => (c.type === 'reasoning' ? c.text : '')).join('');
}
function finishOf(chunks: ChatChunk[]) {
  const f = chunks.at(-1);
  if (f?.type !== 'finish') throw new Error('last chunk is not finish');
  return f;
}

describe('ollama', () => {
  const stream = (name: string) => () => streamResponse(fixtureBytes(name), { cuts: [7, 33, 150] });

  it('health reports the version', async () => {
    const { provider } = makeProvider('ollama', {
      'GET /api/version': () => json({ version: '0.12.6' }),
    });
    await expect(provider.health()).resolves.toMatchObject({
      ok: true,
      version: '0.12.6',
      diagnosis: 'ok',
    });
  });

  it('diagnoses the OLLAMA_ORIGINS 403 and a closed port', async () => {
    const blocked = makeProvider('ollama', {
      'GET /api/version': () => new Response(null, { status: 403 }),
    });
    await expect(blocked.provider.health()).resolves.toMatchObject({
      ok: false,
      diagnosis: 'origin-blocked',
      status: 403,
    });
    const closed = makeProvider('ollama', {});
    await expect(closed.provider.health()).resolves.toMatchObject({ diagnosis: 'unreachable' });
  });

  it('catches an origin block that only applies to POST (Chrome omits Origin on GET)', async () => {
    const { provider, calls } = makeProvider('ollama', {
      'GET /api/version': () => json({ version: '0.12.6' }),
      'POST /api/show': () => new Response(null, { status: 403 }),
    });
    await expect(provider.health()).resolves.toMatchObject({
      ok: false,
      diagnosis: 'origin-blocked',
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/version',
      'POST /api/show',
    ]);
  });

  it('treats the probe’s 404 as healthy', async () => {
    const { provider } = makeProvider('ollama', {
      'GET /api/version': () => json({ version: '0.12.6' }),
      'POST /api/show': () => json({ error: "model '__tether_origin_probe__' not found" }, 404),
    });
    await expect(provider.health()).resolves.toMatchObject({ ok: true });
  });

  it('flags a port that answers with something that is not Ollama', async () => {
    const { provider } = makeProvider('ollama', { 'GET /api/version': () => json({ hi: 1 }) });
    await expect(provider.health()).resolves.toMatchObject({ diagnosis: 'bad-response' });
  });

  it('lists models with hot state, params and quantization', async () => {
    const { provider } = makeProvider('ollama', {
      'GET /api/tags': () =>
        json({
          models: [
            {
              name: 'llama3.2:3b',
              size: 2019393189,
              details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
            },
            { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
          ],
        }),
      'GET /api/ps': () => json({ models: [{ name: 'llama3.2:3b' }] }),
    });
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({
      id: 'llama3.2:3b',
      loaded: true,
      parameterSize: '3.2B',
      quantization: 'Q4_K_M',
      family: 'llama',
      sizeBytes: 2019393189,
    });
    expect(models[1]).toMatchObject({ loaded: false, kind: 'embeddings' });
  });

  it('parses capabilities from /api/show, with legacy inference and overrides', async () => {
    expect(
      capabilitiesFromShow({
        capabilities: ['completion', 'tools', 'thinking'],
        details: { quantization_level: 'Q8_0' },
        model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
      }),
    ).toMatchObject({
      nativeTools: true,
      vision: false,
      thinking: true,
      contextLength: 40960,
      quantization: 'Q8_0',
      jsonSchema: true,
    });
    expect(
      capabilitiesFromShow({ template: '{{ if .Tools }}…{{ end }}', projector_info: { a: 1 } }),
    ).toMatchObject({ nativeTools: true, vision: true });
    expect(capabilitiesFromShow({ capabilities: ['embedding'] })).toMatchObject({
      embedding: true,
    });

    const { provider, overrides } = makeProvider('ollama', {
      'POST /api/show': () => json({ capabilities: ['completion', 'tools'] }),
    });
    await overrides.set('ollama', 'm', { nativeTools: false });
    await expect(provider.capabilities('m')).resolves.toMatchObject({ nativeTools: false });
  });

  it('streams text with usage and server-measured speed', async () => {
    const { provider, calls } = makeProvider('ollama', {
      'POST /api/chat': stream('ollama-chat-basic.ndjson'),
    });
    const chunks = await collect(
      provider.chat(
        { ...REQ, options: { temperature: 0.2, numCtx: 8192, maxTokens: 64 } },
        signal(),
      ),
    );
    expect(textOf(chunks)).toBe('Bonjour — ça va? 👋 你好');
    expect(finishOf(chunks)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: {
        promptTokens: 26,
        completionTokens: 5,
        tokensPerSecond: 25,
        loadMs: 1850,
        promptMs: 120,
      },
    });
    expect(calls[0]?.body).toMatchObject({
      stream: true,
      options: { temperature: 0.2, num_ctx: 8192, num_predict: 64 },
    });
  });

  it('separates native thinking and maps done_reason', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': stream('ollama-chat-thinking.ndjson'),
    });
    const chunks = await collect(provider.chat({ ...REQ, think: true }, signal()));
    expect(reasoningOf(chunks)).toBe('The user wants a greeting.');
    expect(textOf(chunks)).toBe('Hi there!');
    expect(finishOf(chunks).reason).toBe('length');
  });

  it('emits complete tool calls with JSON-string arguments', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': stream('ollama-chat-tools.ndjson'),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(chunks.find((c) => c.type === 'tool_calls')).toEqual({
      type: 'tool_calls',
      calls: [
        { id: 'call_0', name: 'navigate', arguments: '{"url":"https://example.com"}' },
        { id: 'call_1', name: 'extract', arguments: '{"schema":{"title":"string"}}' },
      ],
    });
    expect(finishOf(chunks).reason).toBe('tool_calls');
  });

  it('surfaces a mid-stream error line', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': stream('ollama-chat-error.ndjson'),
    });
    await expect(collect(provider.chat(REQ, signal()))).rejects.toThrow(
      'Model error: llama runner process has terminated',
    );
  });

  it('downgrades and reports when a model rejects tools', async () => {
    const { provider, overrides } = makeProvider('ollama', {
      'POST /api/chat': () => json({ error: 'gemma:2b does not support tools' }, 400),
    });
    const err = await collect(
      provider.chat({ ...REQ, tools: [{ name: 't', description: '', parameters: {} }] }, signal()),
    ).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('E_TOOLS_UNSUPPORTED');
    await expect(overrides.get('ollama', 'm')).resolves.toEqual({ nativeTools: false });
  });

  it('retries without think when a model rejects thinking', async () => {
    let n = 0;
    const { provider, overrides, calls } = makeProvider('ollama', {
      'POST /api/chat': () =>
        n++ === 0
          ? json({ error: '"llama3.2" does not support thinking' }, 400)
          : streamResponse(fixtureBytes('ollama-chat-basic.ndjson')),
    });
    const chunks = await collect(provider.chat({ ...REQ, think: true }, signal()));
    expect(textOf(chunks)).toContain('Bonjour');
    expect((calls[1]?.body as Record<string, unknown>).think).toBeUndefined();
    await expect(overrides.get('ollama', 'm')).resolves.toEqual({ thinking: false });
  });

  it('fails clearly if the stream ends without done', async () => {
    const bytes = new TextEncoder().encode(
      '{"message":{"role":"assistant","content":"cut"},"done":false}\n',
    );
    const { provider } = makeProvider('ollama', { 'POST /api/chat': () => streamResponse(bytes) });
    await expect(collect(provider.chat(REQ, signal()))).rejects.toThrow(
      'ended before the model finished',
    );
  });

  it('builds a request body with images, tool history, format and options', () => {
    const body = buildOllamaBody({
      model: 'llava',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'click', arguments: '{"id":3}' }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'click' },
      ],
      responseFormat: { type: 'json_schema', name: 's', schema: { type: 'object' } },
      options: { seed: 1, stop: ['\n\n'] },
    });
    expect(body).toEqual({
      model: 'llava',
      stream: true,
      messages: [
        { role: 'user', content: 'what is this', images: ['AAAA'] },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'click', arguments: { id: 3 } } }],
        },
        { role: 'tool', content: 'ok', tool_name: 'click' },
      ],
      format: { type: 'object' },
      options: { seed: 1, stop: ['\n\n'] },
    });
  });

  it('can use the OpenAI-compatible path instead', async () => {
    const { provider, calls } = makeProvider(
      'ollama',
      { 'POST /v1/chat/completions': () => streamResponse(fixtureBytes('lmstudio-sse-usage.sse')) },
      { useOpenAICompat: true },
    );
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(textOf(chunks)).toBe('Paris is the capital — 🇫🇷.');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
  });

  it('checks whether a model is loaded, treating untagged names as :latest', async () => {
    const { provider } = makeProvider('ollama', {
      'GET /api/ps': () => json({ models: [{ name: 'llama3.2:latest' }] }),
    });
    await expect(provider.isLoaded?.('llama3.2')).resolves.toBe(true);
    await expect(provider.isLoaded?.('qwen3:8b')).resolves.toBe(false);
    expect(canonicalOllamaName('a')).toBe('a:latest');
    expect(canonicalOllamaName('a:7b')).toBe('a:7b');
  });

  it('embeds and unloads', async () => {
    const { provider, calls } = makeProvider('ollama', {
      'POST /api/embed': () => json({ embeddings: [[0.1, 0.2]] }),
      'POST /api/generate': () => json({ done: true, done_reason: 'unload' }),
    });
    await expect(provider.embed?.(['x'], 'nomic-embed-text')).resolves.toEqual([[0.1, 0.2]]);
    await provider.unload?.('llama3.2');
    expect(calls[1]?.body).toEqual({ model: 'llama3.2', keep_alive: 0 });
  });
});

describe('openai core', () => {
  it('streams reasoning, text and usage (LM Studio capture)', async () => {
    const { provider, calls } = makeProvider('lmstudio', {
      'POST /v1/chat/completions': () =>
        streamResponse(fixtureBytes('lmstudio-sse-usage.sse'), { cuts: [3, 99, 400] }),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(reasoningOf(chunks)).toBe('Short answer.');
    expect(textOf(chunks)).toBe('Paris is the capital — 🇫🇷.');
    expect(finishOf(chunks)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { promptTokens: 24, completionTokens: 9 },
    });
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('reads llama.cpp timings', async () => {
    const { provider } = makeProvider('llamacpp', {
      'POST /v1/chat/completions': () => streamResponse(fixtureBytes('llamacpp-sse-timings.sse')),
    });
    const chunks = await collect(provider.chat({ ...REQ, grammar: 'root ::= "x"' }, signal()));
    expect(textOf(chunks)).toBe('Hello world');
    expect(finishOf(chunks)).toEqual({
      type: 'finish',
      reason: 'length',
      usage: { promptTokens: 11, completionTokens: 2, tokensPerSecond: 49.875, promptMs: 35.2 },
    });
  });

  it('assembles streamed tool-call deltas across chunks and calls (vLLM capture)', async () => {
    const { provider } = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () => streamResponse(fixtureBytes('vllm-sse-tools.sse')),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(chunks.find((c) => c.type === 'tool_calls')).toEqual({
      type: 'tool_calls',
      calls: [
        { id: 'chatcmpl-tool-aa', name: 'click', arguments: '{"id": 42}' },
        { id: 'chatcmpl-tool-bb', name: 'type', arguments: '{"id": 7, "text": "café ☕"}' },
      ],
    });
    expect(finishOf(chunks).reason).toBe('tool_calls');
  });

  it('reclassifies untagged reasoning that closes mid-stream', async () => {
    const { provider } = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        streamResponse(fixtureBytes('openai-sse-untagged-think.sse')),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    let text = '';
    let reasoning = '';
    for (const c of chunks) {
      if (c.type === 'text') text += c.text;
      if (c.type === 'reasoning') reasoning += c.text;
      if (c.type === 'reclassify-reasoning') {
        reasoning += text;
        text = '';
      }
    }
    expect(reasoning).toBe('Okay, the user asks for 2+2.\n');
    expect(text).toBe('The answer is **4**.');
  });

  it('handles CRLF, comments and multi-line data', async () => {
    const { provider } = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () => streamResponse(fixtureBytes('sse-crlf-comments.sse')),
    });
    expect(textOf(await collect(provider.chat(REQ, signal())))).toBe('line one + two');
  });

  it('persists a tools downgrade on 400/422 but not for context-length errors', async () => {
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }];
    const rejected = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        json({ error: { message: 'tools is not supported', type: 'invalid_request_error' } }, 422),
    });
    const err = await collect(rejected.provider.chat({ ...REQ, tools }, signal())).catch(
      (e: unknown) => e,
    );
    expect((err as { code: string }).code).toBe('E_TOOLS_UNSUPPORTED');
    await expect(rejected.overrides.get('openai-compatible', 'm')).resolves.toEqual({
      nativeTools: false,
    });
    await expect(rejected.provider.capabilities('m')).resolves.toMatchObject({
      nativeTools: false,
    });

    const ctx = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        json({ error: { message: 'This model maximum context length is 4096 tokens' } }, 400),
    });
    const err2 = await collect(ctx.provider.chat({ ...REQ, tools }, signal())).catch(
      (e: unknown) => e,
    );
    expect(err2).toBeInstanceOf(ProviderError);
    await expect(ctx.overrides.get('openai-compatible', 'm')).resolves.toEqual({});
  });

  it('treats llama.cpp\'s "requires --jinja" 500 as a tools rejection', () => {
    const e = new ProviderError('E_HTTP', 'x', {
      status: 500,
      serverMessage: 'tools param requires --jinja flag',
    });
    expect(isToolsRejection(e, true)).toBe(true);
    expect(isToolsRejection(e, false)).toBe(false);
    expect(
      isToolsRejection(
        new ProviderError('E_HTTP', 'x', { status: 500, serverMessage: 'OOM' }),
        true,
      ),
    ).toBe(false);
  });

  it('retries once without stream_options and remembers', async () => {
    let n = 0;
    const { provider, overrides, calls } = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        n++ === 0
          ? json({ error: { message: 'Unrecognized request argument: stream_options' } }, 400)
          : streamResponse(fixtureBytes('llamacpp-sse-timings.sse')),
    });
    expect(textOf(await collect(provider.chat(REQ, signal())))).toBe('Hello world');
    expect((calls[1]?.body as Record<string, unknown>).stream_options).toBeUndefined();
    await expect(overrides.get('openai-compatible', 'm')).resolves.toEqual({ streamUsage: false });
    await collect(provider.chat(REQ, signal())).catch(() => undefined);
    expect((calls[2]?.body as Record<string, unknown>).stream_options).toBeUndefined();
  });

  it('surfaces mid-stream error events and truncated streams', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const errored = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        streamResponse(
          enc(
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"error":{"message":"model crashed"}}\n\n',
          ),
        ),
    });
    await expect(collect(errored.provider.chat(REQ, signal()))).rejects.toThrow('model crashed');
    const truncated = makeProvider('openai-compatible', {
      'POST /v1/chat/completions': () =>
        streamResponse(enc('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')),
    });
    await expect(collect(truncated.provider.chat(REQ, signal()))).rejects.toThrow(
      'ended before the model finished',
    );
  });

  it('sends the API key and maps the base URL with or without /v1', async () => {
    const { provider, calls } = makeProvider(
      'openai-compatible',
      { 'GET /v1/models': () => json({ data: [{ id: 'a', max_model_len: 32768 }] }) },
      { apiKey: 'sk-local-123', baseUrl: 'http://127.0.0.1:9999/v1' },
    );
    await expect(provider.listModels()).resolves.toEqual([
      { id: 'a', name: 'a', instanceId: 'openai-compatible', contextLength: 32768 },
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/v1/models');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-local-123');
  });

  it('builds bodies for JSON mode per dialect, schemas, tools and images', () => {
    const req: ChatRequest = {
      ...REQ,
      responseFormat: { type: 'json' },
      tools: [{ name: 'click', description: 'Click', parameters: { type: 'object' } }],
      options: { topP: 0.9, maxTokens: 10 },
    };
    expect(buildOpenAIBody(req, { jsonModeAs: 'json_object', streamUsage: false })).toMatchObject({
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'click' } }],
      top_p: 0.9,
      max_tokens: 10,
    });
    expect(
      buildOpenAIBody(req, { jsonModeAs: 'json_schema', streamUsage: true }).response_format,
    ).toEqual({ type: 'json_schema', json_schema: { name: 'json', schema: { type: 'object' } } });
    expect(
      buildOpenAIBody(
        {
          ...REQ,
          responseFormat: { type: 'json_schema', name: 'step', schema: { type: 'object' } },
        },
        { jsonModeAs: 'json_object', streamUsage: false },
      ).response_format,
    ).toEqual({
      type: 'json_schema',
      json_schema: { name: 'step', strict: true, schema: { type: 'object' } },
    });
    expect(
      toOpenAIMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        ],
      },
    ]);
  });
});

describe('lm studio', () => {
  const v0 = {
    data: [
      {
        id: 'qwen2.5-7b-instruct',
        type: 'llm',
        arch: 'qwen2',
        quantization: 'Q4_K_M',
        state: 'loaded',
        max_context_length: 32768,
        capabilities: ['tool_use'],
      },
      { id: 'gemma-3-12b-it', type: 'vlm', state: 'not-loaded', max_context_length: 131072 },
      { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
    ],
  };

  it('uses the richer /api/v0 listing', async () => {
    const { provider } = makeProvider('lmstudio', { 'GET /api/v0/models': () => json(v0) });
    const models = await provider.listModels();
    expect(models.map((m) => [m.id, m.loaded, m.kind])).toEqual([
      ['qwen2.5-7b-instruct', true, 'llm'],
      ['gemma-3-12b-it', false, 'vlm'],
      ['text-embedding-nomic', false, 'embeddings'],
    ]);
    expect(models[0]?.capabilities).toMatchObject({
      nativeTools: true,
      contextLength: 32768,
      quantization: 'Q4_K_M',
      jsonSchema: true,
      grammar: false,
    });
    expect(models[1]?.capabilities).toMatchObject({ vision: true, nativeTools: true });
    expect(models[2]?.capabilities).toMatchObject({ embedding: true, nativeTools: false });
    await expect(provider.isLoaded?.('gemma-3-12b-it')).resolves.toBe(false);
  });

  it('falls back to /v1/models on older builds', async () => {
    const { provider } = makeProvider('lmstudio', {
      'GET /api/v0/models': () => json({ error: 'Unexpected endpoint' }, 404),
      'GET /v1/models': () => json({ data: [{ id: 'x' }] }),
    });
    await expect(provider.health()).resolves.toMatchObject({ ok: true });
    await expect(provider.listModels()).resolves.toEqual([
      { id: 'x', name: 'x', instanceId: 'lmstudio' },
    ]);
  });

  it('treats missing capability lists optimistically', () => {
    expect(lmsCapabilities({ id: 'a', type: 'llm' }).nativeTools).toBe(true);
    expect(lmsCapabilities({ id: 'a', type: 'llm', capabilities: [] }).nativeTools).toBe(false);
  });
});

describe('llama.cpp', () => {
  const props = {
    default_generation_settings: { n_ctx: 8192 },
    chat_template: '{% if tools %}{{ tools }}{% endif %}',
    modalities: { vision: true },
    build_info: 'b6500-1a2b3c',
  };

  it('reports build info as version and capabilities from /props', async () => {
    const { provider } = makeProvider('llamacpp', {
      'GET /props': () => json(props),
      'GET /v1/models': () => json({ data: [{ id: 'mock.gguf' }] }),
    });
    await expect(provider.health()).resolves.toMatchObject({ ok: true, version: 'b6500-1a2b3c' });
    const [model] = await provider.listModels();
    expect(model).toMatchObject({ id: 'mock.gguf', loaded: true, contextLength: 8192 });
    expect(model?.capabilities).toMatchObject({
      nativeTools: true,
      vision: true,
      grammar: true,
      jsonSchema: true,
      contextLength: 8192,
    });
  });

  it('reports loading as a reachable-but-not-ready state', async () => {
    const { provider } = makeProvider('llamacpp', {
      'GET /props': () => json({ error: { message: 'Loading model', code: 503 } }, 503),
    });
    await expect(provider.health()).resolves.toMatchObject({
      ok: false,
      diagnosis: 'http-error',
      status: 503,
      detail: 'llama.cpp is still loading the model',
    });
  });

  it('is not fooled by another OpenAI server on :8080', async () => {
    const { provider } = makeProvider('llamacpp', { 'GET /props': () => json({ object: 'x' }) });
    await expect(provider.health()).resolves.toMatchObject({ diagnosis: 'bad-response' });
  });

  it('sends grammar in the request body', async () => {
    const { provider, calls } = makeProvider('llamacpp', {
      'POST /v1/chat/completions': () => streamResponse(fixtureBytes('llamacpp-sse-timings.sse')),
    });
    await collect(provider.chat({ ...REQ, grammar: 'root ::= "yes" | "no"' }, signal()));
    expect(calls[0]?.body).toMatchObject({ grammar: 'root ::= "yes" | "no"' });
  });

  it('infers no native tools from a template without them', () => {
    expect(llamaCapabilities({ chat_template: '{{ messages }}' }).nativeTools).toBe(false);
  });
});

/** Byte-for-byte captures from Ollama 0.40.6 running ornith-1.5:9b (Q4_K_M). */
describe('real Ollama captures', () => {
  const real = (name: string) => () => streamResponse(fixtureBytes(name), { cuts: [11, 97, 503] });

  it('native chat without thinking', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': real('real-ollama-chat-nothink.ndjson'),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(textOf(chunks)).toBe('Hello there, wonderful friend!');
    expect(finishOf(chunks)).toMatchObject({
      reason: 'stop',
      usage: { promptTokens: 19, completionTokens: 7 },
    });
    expect(finishOf(chunks).usage.tokensPerSecond).toBeCloseTo(7 / 0.408978, 3);
  });

  it('native thinking arrives in message.thinking and stays out of the text', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': real('real-ollama-chat-think.ndjson'),
    });
    const chunks = await collect(provider.chat({ ...REQ, think: true }, signal()));
    expect(reasoningOf(chunks)).toMatch(/^The user is asking/);
    expect(textOf(chunks)).toBe('51');
  });

  it('native tool call keeps the server-assigned id', async () => {
    const { provider } = makeProvider('ollama', {
      'POST /api/chat': real('real-ollama-chat-tools.ndjson'),
    });
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(chunks.find((c) => c.type === 'tool_calls')).toEqual({
      type: 'tool_calls',
      calls: [{ id: 'aW7hVaT0SaIG65u7b3awOGt2CZvZ0GvU', name: 'click', arguments: '{"id":42}' }],
    });
    expect(finishOf(chunks).reason).toBe('tool_calls');
  });

  it('OpenAI-compatible path reads usage and llama.cpp-style timings', async () => {
    const { provider } = makeProvider(
      'ollama',
      { 'POST /v1/chat/completions': real('real-ollama-v1-sse.sse') },
      { useOpenAICompat: true },
    );
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(textOf(chunks)).toBe('Hello there, wonderful friend!');
    expect(finishOf(chunks).usage).toMatchObject({
      promptTokens: 19,
      completionTokens: 7,
      tokensPerSecond: 18.276762402088774,
    });
  });

  it('OpenAI-compatible tool call', async () => {
    const { provider } = makeProvider(
      'ollama',
      { 'POST /v1/chat/completions': real('real-ollama-v1-tools.sse') },
      { useOpenAICompat: true },
    );
    const chunks = await collect(provider.chat(REQ, signal()));
    expect(chunks.find((c) => c.type === 'tool_calls')).toEqual({
      type: 'tool_calls',
      calls: [{ id: '1no0yWTrG6seyq6BSIt3xDElOFAiZCc1', name: 'click', arguments: '{"id":42}' }],
    });
  });

  it('reads capabilities from a real /api/show shape', () => {
    expect(
      capabilitiesFromShow({
        capabilities: ['tools', 'thinking', 'completion', 'vision'],
        details: { quantization_level: 'Q4_K_M', parameter_size: '9.0B' },
        model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 },
        projector_info: {},
      }),
    ).toMatchObject({
      nativeTools: true,
      thinking: true,
      vision: true,
      contextLength: 262144,
      quantization: 'Q4_K_M',
    });
  });
});
