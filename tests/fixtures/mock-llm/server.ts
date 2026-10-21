import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Mock local-LLM backend for tests and offline development.
 *
 * One instance impersonates one backend flavour (they live on different ports
 * in reality). Wire formats follow the real servers closely enough that the
 * provider adapters can't tell the difference.
 *
 * Behaviour is chosen by substrings in the requested model name:
 *   slow        first token after 1500 ms
 *   cold        reports not loaded; first token after 2500 ms, then loaded
 *   disconnect  3 tokens, then the socket is destroyed mid-stream
 *   notools     400 when the request carries tools
 *   toolcall    calls the first tool with {"id": 3} instead of replying
 *   think       reasoning ("Let me think.") before the reply
 *   error       an error object mid-stream
 *   nousage     400 when stream_options is present (OpenAI flavours)
 */

export type MockFlavor = 'ollama' | 'lmstudio' | 'llamacpp' | 'openai';

export interface MockModel {
  id: string;
  loaded?: boolean;
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  embedding?: boolean;
  contextLength?: number;
  quant?: string;
  params?: string;
}

export interface MockOptions {
  flavor: MockFlavor;
  port?: number;
  models?: MockModel[];
  rejectOrigins?: boolean;
  allowedOrigins?: string[];
  apiKey?: string;
  reply?: string;
  tokenDelayMs?: number;
  /**
   * Ollama flavor: decide each reply from the request (for scripted agent
   * runs). Return undefined to fall back to the default behaviour.
   */
  script?: (body: MockChatBody) => MockScriptReply | undefined;
}

export interface MockChatBody {
  model?: string;
  messages?: { role?: string; content?: unknown }[];
  tools?: { function?: { name?: string } }[];
  format?: unknown;
  think?: unknown;
}

export interface MockScriptReply {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const SLOW_TTFT_MS = 1500;
const COLD_TTFT_MS = 2500;
const REASONING = 'Let me think.';

const DEFAULT_MODELS: Record<MockFlavor, MockModel[]> = {
  ollama: [
    {
      id: 'llama3.2:3b',
      loaded: true,
      tools: true,
      params: '3.2B',
      quant: 'Q4_K_M',
      contextLength: 131072,
    },
    {
      id: 'qwen3:8b',
      tools: true,
      thinking: true,
      params: '8.2B',
      quant: 'Q4_K_M',
      contextLength: 40960,
    },
    { id: 'llava:7b', vision: true, params: '7B', quant: 'Q4_0', contextLength: 32768 },
    {
      id: 'nomic-embed-text:latest',
      embedding: true,
      params: '137M',
      quant: 'F16',
      contextLength: 2048,
    },
  ],
  lmstudio: [
    { id: 'qwen2.5-7b-instruct', loaded: true, tools: true, quant: 'Q4_K_M', contextLength: 32768 },
    { id: 'gemma-3-12b-it', vision: true, quant: 'Q4_K_M', contextLength: 131072 },
    {
      id: 'text-embedding-nomic-embed-text-v1.5',
      embedding: true,
      quant: 'Q8_0',
      contextLength: 2048,
    },
  ],
  llamacpp: [{ id: 'mock.gguf', loaded: true, tools: true, contextLength: 8192 }],
  openai: [{ id: 'Qwen/Qwen2.5-7B-Instruct', loaded: true, tools: true, contextLength: 32768 }],
};

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ToolDef {
  function?: { name?: string };
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolDef[];
  stream?: boolean;
  think?: unknown;
  stream_options?: { include_usage?: boolean };
  keep_alive?: unknown;
  input?: unknown;
}

interface ModelState extends MockModel {
  loaded: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function promptTokens(messages: ChatMessage[] | undefined): number {
  let chars = 0;
  for (const m of messages ?? []) {
    chars +=
      typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/** Deterministic unit-length 8-dim vector derived from an FNV-1a hash. */
export function mockEmbedding(text: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const v = Array.from({ length: 8 }, (_, i) => Math.sin(h / 1e6 + i * 1.7));
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (!pattern.includes('*')) return pattern === origin;
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return re.test(origin);
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function digestOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

function family(model: MockModel): string {
  if (model.embedding) return 'nomic-bert';
  if (model.id.startsWith('qwen')) return 'qwen3';
  return 'llama';
}

export async function startMockLlm(opts: MockOptions): Promise<MockServer> {
  const flavor = opts.flavor;
  const reply = opts.reply ?? 'Hello from the mock model.';
  const tokenDelay = opts.tokenDelayMs ?? 5;
  const allowedOrigins = opts.allowedOrigins ?? [];
  const requests: RecordedRequest[] = [];
  const models = new Map<string, ModelState>();
  for (const m of opts.models ?? DEFAULT_MODELS[flavor]) {
    models.set(m.id, { ...m, loaded: m.id.includes('cold') ? false : (m.loaded ?? false) });
  }

  /** Track every model name ever requested so `cold` state survives across requests. */
  const stateFor = (name: string): ModelState => {
    let state = models.get(name);
    if (!state) {
      // OpenAI-style servers accept whatever model they serve; remember it.
      state = { id: name, loaded: !name.includes('cold'), tools: true };
      if (flavor !== 'ollama') models.set(name, state);
    }
    return state;
  };

  const ttftFor = (name: string): number => {
    const state = models.get(name);
    if (name.includes('cold') && !(state?.loaded ?? false)) return COLD_TTFT_MS;
    if (name.includes('slow')) return SLOW_TTFT_MS;
    return tokenDelay;
  };

  const markLoaded = (name: string) => {
    const state = models.get(name);
    if (state) state.loaded = true;
  };

  // --- Ollama native ---------------------------------------------------------

  const ollamaModelEntry = (m: MockModel) => ({
    name: m.id,
    model: m.id,
    modified_at: '2026-09-01T10:00:00.000Z',
    size: 2_019_393_189,
    digest: digestOf(m.id),
    details: {
      parent_model: '',
      format: 'gguf',
      family: family(m),
      families: [family(m)],
      parameter_size: m.params ?? '7B',
      quantization_level: m.quant ?? 'Q4_K_M',
    },
  });

  async function ollamaChat(req: IncomingMessage, res: ServerResponse, body: ChatBody) {
    const name = body.model ?? '';
    const known = models.get(name);
    if (!known) {
      sendJson(res, 404, { error: `model '${name}' not found` });
      return;
    }
    if (name.includes('notools') && (body.tools?.length ?? 0) > 0) {
      sendJson(res, 400, { error: 'tools not supported' });
      return;
    }
    const scripted = opts.script?.(body);
    if (scripted) {
      markLoaded(name);
      const msg: Record<string, unknown> = { role: 'assistant', content: scripted.text ?? '' };
      if (scripted.toolCalls?.length) {
        msg.tool_calls = scripted.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      const final = {
        model: name,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '' },
        done_reason: 'stop',
        done: true,
        prompt_eval_count: promptTokens(body.messages),
        eval_count: 5,
        eval_duration: 5_000_000,
      };
      if (body.stream === false) {
        sendJson(res, 200, { ...final, message: msg });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ model: name, created_at: new Date().toISOString(), message: msg, done: false })}\n`,
      );
      res.write(`${JSON.stringify(final)}\n`);
      res.end();
      return;
    }
    const wasCold = name.includes('cold') && !known.loaded;
    const ttft = ttftFor(name);
    const pTokens = promptTokens(body.messages);
    const tokens = tokenize(reply);
    const thinkSeparately = body.think === true || typeof body.think === 'string';
    const toolName = body.tools?.[0]?.function?.name;
    const started = process.hrtime.bigint();

    const doneLine = (evalCount: number) => {
      const total = Number(process.hrtime.bigint() - started);
      return {
        model: name,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '' },
        done_reason: 'stop',
        done: true,
        total_duration: total,
        load_duration: wasCold ? COLD_TTFT_MS * 1e6 : 12_000_000,
        prompt_eval_count: pTokens,
        prompt_eval_duration: 20_000_000,
        eval_count: evalCount,
        eval_duration: Math.max(1, evalCount) * Math.max(1, tokenDelay) * 1e6,
      };
    };

    if (body.stream === false) {
      await sleep(ttft);
      markLoaded(name);
      const message: Record<string, unknown> = { role: 'assistant', content: reply };
      if (name.includes('toolcall') && toolName) {
        message.content = '';
        message.tool_calls = [{ function: { name: toolName, arguments: { id: 3 } } }];
      } else if (name.includes('think')) {
        if (thinkSeparately) message.thinking = REASONING;
        else message.content = `<think>${REASONING}</think>${reply}`;
      }
      sendJson(res, 200, { ...doneLine(tokens.length), message });
      return;
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const line = (obj: unknown) => {
      if (!closed) res.write(`${JSON.stringify(obj)}\n`);
    };
    const chunk = (message: Record<string, unknown>) => ({
      model: name,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '', ...message },
      done: false,
    });

    await sleep(ttft);
    markLoaded(name);
    let count = 0;

    if (name.includes('toolcall') && toolName) {
      line(chunk({ tool_calls: [{ function: { name: toolName, arguments: { id: 3 } } }] }));
      line(doneLine(1));
      res.end();
      return;
    }

    if (name.includes('think')) {
      if (thinkSeparately) {
        for (const t of tokenize(REASONING)) {
          line(chunk({ thinking: t }));
          await sleep(tokenDelay);
        }
      } else {
        for (const t of ['<think>', ...tokenize(REASONING), '</think>']) {
          line(chunk({ content: t }));
          count += 1;
          await sleep(tokenDelay);
        }
      }
    }

    for (const t of tokens) {
      if (res.destroyed) return;
      if (name.includes('disconnect') && count === 3) {
        req.socket.destroy();
        return;
      }
      if (name.includes('error') && count === 2) {
        line({ error: 'model crashed' });
        res.end();
        return;
      }
      line(chunk({ content: t }));
      count += 1;
      await sleep(tokenDelay);
    }
    line(doneLine(count));
    res.end();
  }

  // --- OpenAI-compatible -----------------------------------------------------

  function openAiError(res: ServerResponse, status: number, message: string, type: string) {
    sendJson(res, status, { error: { message, type, code: null } });
  }

  async function openAiChat(req: IncomingMessage, res: ServerResponse, body: ChatBody) {
    const name = body.model ?? '';
    if (flavor !== 'llamacpp' && flavor !== 'ollama' && !name) {
      openAiError(res, 400, 'model is required', 'invalid_request_error');
      return;
    }
    if (flavor === 'ollama' && !models.has(name)) {
      openAiError(res, 404, `model "${name}" not found, try pulling it first`, 'api_error');
      return;
    }
    if (name.includes('nousage') && body.stream_options) {
      openAiError(
        res,
        400,
        'Unrecognized request argument: stream_options',
        'invalid_request_error',
      );
      return;
    }
    if (name.includes('notools') && (body.tools?.length ?? 0) > 0) {
      openAiError(res, 400, 'tools is not supported for this model', 'invalid_request_error');
      return;
    }
    stateFor(name);
    const ttft = ttftFor(name);
    const pTokens = promptTokens(body.messages);
    const tokens = tokenize(reply);
    const toolName = body.tools?.[0]?.function?.name;
    const id = `chatcmpl-${digestOf(name).slice(0, 12)}`;
    const created = nowSeconds();
    const wantsTool = name.includes('toolcall') && toolName !== undefined;
    const startedMs = Date.now();

    const timings = (predicted: number) => {
      const predictedMs = Math.max(1, Date.now() - startedMs - ttft);
      return {
        prompt_n: pTokens,
        prompt_ms: 20,
        predicted_n: predicted,
        predicted_ms: predictedMs,
        predicted_per_second: (predicted / predictedMs) * 1000,
      };
    };
    const usage = (completion: number) => ({
      prompt_tokens: pTokens,
      completion_tokens: completion,
      total_tokens: pTokens + completion,
    });

    if (body.stream !== true) {
      await sleep(ttft);
      markLoaded(name);
      const message: Record<string, unknown> = { role: 'assistant', content: reply };
      if (wantsTool) {
        message.content = null;
        message.tool_calls = [
          { id: 'call_1', type: 'function', function: { name: toolName, arguments: '{"id": 3}' } },
        ];
      } else if (name.includes('think')) {
        message.reasoning_content = REASONING;
      }
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: name,
        choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
        usage: usage(tokens.length),
        ...(flavor === 'llamacpp' ? { timings: timings(tokens.length) } : {}),
      });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const send = (data: unknown) => {
      if (!closed) res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: name,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    await sleep(ttft);
    markLoaded(name);
    let count = 0;
    let first = true;
    const delta = (d: Record<string, unknown>) => {
      const out = first ? { role: 'assistant', ...d } : d;
      first = false;
      return out;
    };

    if (wantsTool) {
      send(
        chunk(
          delta({
            content: null,
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: toolName, arguments: '' },
              },
            ],
          }),
        ),
      );
      for (const fragment of ['{"id"', ': 3}']) {
        await sleep(tokenDelay);
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: fragment } }] }));
      }
      count = 3;
    } else {
      if (name.includes('think')) {
        for (const t of tokenize(REASONING)) {
          send(chunk(delta({ content: null, reasoning_content: t })));
          await sleep(tokenDelay);
        }
      }
      for (const t of tokens) {
        if (res.destroyed) return;
        if (name.includes('disconnect') && count === 3) {
          req.socket.destroy();
          return;
        }
        if (name.includes('error') && count === 2) {
          send({ error: { message: 'model crashed', type: 'server_error' } });
          res.end();
          return;
        }
        send(chunk(delta({ content: t })));
        count += 1;
        await sleep(tokenDelay);
      }
    }

    const finalChunk: Record<string, unknown> = chunk({}, wantsTool ? 'tool_calls' : 'stop');
    if (flavor === 'llamacpp') finalChunk.timings = timings(count);
    send(finalChunk);
    if (body.stream_options?.include_usage) {
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: name,
        choices: [],
        usage: usage(count),
      });
    }
    send('[DONE]');
    res.end();
  }

  function embeddingInputs(input: unknown): string[] {
    if (typeof input === 'string') return [input];
    if (Array.isArray(input)) return input.map((x) => String(x));
    return [];
  }

  // --- Router ----------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://mock').pathname;
    const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
    requests.push({ method, path, headers: { ...req.headers }, body });

    const origin = req.headers.origin;
    if (
      flavor === 'ollama' &&
      opts.rejectOrigins &&
      origin &&
      !originAllowed(origin, allowedOrigins)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }

    if (opts.apiKey && path.startsWith('/v1/')) {
      if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        openAiError(res, 401, 'Invalid API key', 'invalid_request_error');
        return;
      }
    }

    const b = (body ?? {}) as ChatBody;
    const route = `${method} ${path}`;

    if (flavor === 'ollama') {
      switch (route) {
        case 'GET /':
        case 'HEAD /':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Ollama is running');
          return;
        case 'GET /api/version':
          sendJson(res, 200, { version: '0.12.6' });
          return;
        case 'GET /api/tags':
          sendJson(res, 200, { models: [...models.values()].map(ollamaModelEntry) });
          return;
        case 'GET /api/ps':
          sendJson(res, 200, {
            models: [...models.values()]
              .filter((m) => m.loaded)
              .map((m) => ({
                ...ollamaModelEntry(m),
                expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
                size_vram: 2_019_393_189,
                context_length: Math.min(m.contextLength ?? 4096, 4096),
              })),
          });
          return;
        case 'POST /api/show': {
          const name =
            (body as { model?: string; name?: string } | null)?.model ??
            (body as { name?: string } | null)?.name ??
            '';
          const m = models.get(name);
          if (!m) {
            sendJson(res, 404, { error: `model '${name}' not found` });
            return;
          }
          const arch = m.embedding ? 'nomic-bert' : 'llama';
          const capabilities = m.embedding
            ? ['embedding']
            : [
                'completion',
                ...(m.tools ? ['tools'] : []),
                ...(m.vision ? ['vision'] : []),
                ...(m.thinking ? ['thinking'] : []),
              ];
          sendJson(res, 200, {
            modelfile: `FROM ${m.id}`,
            parameters: 'stop "<|eot_id|>"',
            template: '{{ .Prompt }}',
            details: ollamaModelEntry(m).details,
            model_info: {
              'general.architecture': arch,
              'general.parameter_count': 3_212_749_888,
              [`${arch}.context_length`]: m.contextLength ?? 4096,
            },
            capabilities,
            modified_at: '2026-09-01T10:00:00.000Z',
          });
          return;
        }
        case 'POST /api/chat':
          await ollamaChat(req, res, b);
          return;
        case 'POST /api/embed': {
          const name = b.model ?? '';
          if (!models.has(name)) {
            sendJson(res, 404, { error: `model '${name}' not found` });
            return;
          }
          const inputs = embeddingInputs(b.input);
          sendJson(res, 200, {
            model: name,
            embeddings: inputs.map(mockEmbedding),
            total_duration: 1_000_000,
            load_duration: 100_000,
            prompt_eval_count: inputs.join(' ').length,
          });
          return;
        }
        case 'POST /api/generate': {
          const name = b.model ?? '';
          const m = models.get(name);
          if (!m) {
            sendJson(res, 404, { error: `model '${name}' not found` });
            return;
          }
          if (b.keep_alive === 0 || b.keep_alive === '0') {
            m.loaded = false;
            sendJson(res, 200, {
              model: name,
              created_at: new Date().toISOString(),
              response: '',
              done: true,
              done_reason: 'unload',
            });
            return;
          }
          sendJson(res, 501, { error: 'generate is not implemented by the mock' });
          return;
        }
      }
    }

    if (flavor === 'lmstudio' && route === 'GET /api/v0/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [...models.values()].map((m) => ({
          id: m.id,
          object: 'model',
          type: m.embedding ? 'embeddings' : m.vision ? 'vlm' : 'llm',
          publisher: 'mock',
          arch: 'llama',
          compatibility_type: 'gguf',
          quantization: m.quant ?? 'Q4_K_M',
          state: m.loaded ? 'loaded' : 'not-loaded',
          max_context_length: m.contextLength ?? 4096,
          ...(m.tools ? { capabilities: ['tool_use'] } : {}),
        })),
      });
      return;
    }

    if (flavor === 'llamacpp') {
      if (route === 'GET /health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (route === 'GET /props') {
        sendJson(res, 200, {
          default_generation_settings: { n_ctx: 8192, params: { temperature: 0.8, top_p: 0.95 } },
          total_slots: 1,
          model_path: '/models/mock.gguf',
          chat_template:
            '{% if tools %}{{ tools | tojson }}{% endif %}{% for m in messages %}…{% endfor %}',
          modalities: { vision: false },
          build_info: 'b6500-mock',
        });
        return;
      }
    }

    if ((flavor === 'openai' || flavor === 'lmstudio') && route === 'GET /version') {
      sendJson(res, 200, { version: '0.11.0' });
      return;
    }

    switch (route) {
      case 'GET /v1/models':
        sendJson(res, 200, {
          object: 'list',
          data: [...models.values()].map((m) => ({
            id: m.id,
            object: 'model',
            created: 1_756_000_000,
            owned_by: flavor === 'ollama' ? 'library' : 'mock',
            ...(flavor === 'openai' ? { max_model_len: m.contextLength ?? 4096 } : {}),
          })),
        });
        return;
      case 'POST /v1/chat/completions':
        await openAiChat(req, res, b);
        return;
      case 'POST /v1/embeddings': {
        const inputs = embeddingInputs(b.input);
        sendJson(res, 200, {
          object: 'list',
          data: inputs.map((t, index) => ({
            object: 'embedding',
            embedding: mockEmbedding(t),
            index,
          })),
          model: b.model ?? '',
          usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
        });
        return;
      }
    }

    if (path.startsWith('/v1/')) {
      openAiError(
        res,
        404,
        `Unexpected endpoint or method. (${method} ${path})`,
        'invalid_request_error',
      );
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 page not found');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server has no address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
