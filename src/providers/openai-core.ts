import { TetherError } from '@/lib/errors';
import { ProviderError, type HttpClient } from './http';
import type { CapabilityOverrides } from './overrides';
import { sseEvents } from './stream';
import { ThinkSplitter } from './think';
import {
  messageImages,
  messageText,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type ModelInfo,
  type ToolCall,
  type Usage,
} from './types';

/**
 * Shared implementation of the OpenAI chat-completions dialect. LM Studio,
 * llama.cpp, vLLM and friends all speak it with small variations, which the
 * adapters express through `OpenAIDialect`.
 */

export interface OpenAIContext {
  http: HttpClient;
  /** Base including the version segment, e.g. http://127.0.0.1:1234/v1 */
  apiBase: string;
  apiKey?: string;
  instanceId: string;
  overrides: CapabilityOverrides;
}

export interface OpenAIDialect {
  /** How to express "any JSON object": json_object (most) or json_schema (LM Studio). */
  jsonModeAs: 'json_object' | 'json_schema';
  /** Extra body fields (llama.cpp `grammar`). */
  extraBody?: (req: ChatRequest) => Record<string, unknown>;
  /** Whether to send stream_options.include_usage. Learned per model. */
  streamUsage: boolean;
}

interface OpenAIMessage {
  role: string;
  content:
    string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    const images = messageImages(m.content);
    const text = messageText(m.content);
    const out: OpenAIMessage = {
      role: m.role,
      content:
        images.length === 0
          ? text
          : [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mimeType};base64,${img.data}` },
              })),
            ],
    };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    if (m.role === 'tool' && m.toolCallId) out.tool_call_id = m.toolCallId;
    if (m.role === 'tool' && m.name) out.name = m.name;
    return out;
  });
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function buildOpenAIBody(req: ChatRequest, dialect: OpenAIDialect): Record<string, unknown> {
  const o = req.options ?? {};
  let responseFormat: unknown;
  const rf = req.responseFormat;
  if (rf?.type === 'json') {
    responseFormat =
      dialect.jsonModeAs === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'json', schema: { type: 'object' } } };
  } else if (rf?.type === 'json_schema') {
    responseFormat = {
      type: 'json_schema',
      json_schema: { name: rf.name, strict: true, schema: rf.schema },
    };
  }
  return compact({
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    stream: true,
    stream_options: dialect.streamUsage ? { include_usage: true } : undefined,
    temperature: o.temperature,
    top_p: o.topP,
    max_tokens: o.maxTokens,
    seed: o.seed,
    stop: o.stop?.length ? o.stop : undefined,
    tools: req.tools?.length
      ? req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined,
    response_format: responseFormat,
    ...dialect.extraBody?.(req),
  });
}

const CONTEXT_ERROR = /context|too long|exceed|maximum.*tokens|n_ctx/i;
const STREAM_OPTIONS_ERROR = /stream_options|include_usage/i;

/** Does this HTTP failure mean "this model/server can't take `tools`"? */
export function isToolsRejection(err: unknown, sentTools: boolean): boolean {
  if (!sentTools || !(err instanceof ProviderError) || err.code !== 'E_HTTP') return false;
  const status = err.status ?? 0;
  const msg = err.serverMessage ?? '';
  if (status === 400 || status === 422) return !CONTEXT_ERROR.test(msg);
  // llama.cpp without --jinja answers 500 "tools param requires --jinja flag".
  return status === 500 && /tool|jinja|function/i.test(msg);
}

export function toolsUnsupported(model: string, cause: unknown): TetherError {
  return new TetherError(
    'E_TOOLS_UNSUPPORTED',
    `${model} does not accept native tool calls; falling back to a text protocol`,
    { cause },
  );
}

export function mapFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'stop':
    case 'eos':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

interface ToolCallDraft {
  id?: string;
  name: string;
  arguments: string;
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

interface StreamPayload {
  choices?: StreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_per_second?: number;
  };
  error?: { message?: string } | string;
}

/** Stream a chat completion, normalized to ChatChunks. */
export async function* openAIChat(
  ctx: OpenAIContext,
  req: ChatRequest,
  signal: AbortSignal,
  dialect: OpenAIDialect,
): AsyncGenerator<ChatChunk, void, void> {
  const sentTools = !!req.tools?.length;
  let body = buildOpenAIBody(req, dialect);
  let res: Response;
  try {
    res = await ctx.http.request(`${ctx.apiBase}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    });
  } catch (err) {
    if (isToolsRejection(err, sentTools)) {
      await ctx.overrides.set(ctx.instanceId, req.model, { nativeTools: false });
      throw toolsUnsupported(req.model, err);
    }
    const msg = err instanceof ProviderError ? (err.serverMessage ?? '') : '';
    if (dialect.streamUsage && err instanceof ProviderError && STREAM_OPTIONS_ERROR.test(msg)) {
      await ctx.overrides.set(ctx.instanceId, req.model, { streamUsage: false });
      body = buildOpenAIBody(req, { ...dialect, streamUsage: false });
      res = await ctx.http.request(`${ctx.apiBase}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
        ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      });
    } else {
      throw err;
    }
  }
  if (!res.body) throw new ProviderError('E_BAD_RESPONSE', 'Empty response body');

  const splitter = new ThinkSplitter();
  const drafts = new Map<number, ToolCallDraft>();
  const usage: Usage = {};
  let finish: FinishReason | undefined;
  let sawDone = false;

  for await (const event of sseEvents(res.body, { signal })) {
    if (event.data === '[DONE]') {
      sawDone = true;
      break;
    }
    let payload: StreamPayload;
    try {
      payload = JSON.parse(event.data) as StreamPayload;
    } catch {
      throw new ProviderError(
        'E_BAD_RESPONSE',
        `Malformed stream event: ${event.data.slice(0, 120)}`,
      );
    }
    if (payload.error) {
      const message =
        typeof payload.error === 'string' ? payload.error : (payload.error.message ?? 'error');
      throw new ProviderError('E_HTTP', `Model error: ${message}`, { serverMessage: message });
    }
    for (const choice of payload.choices ?? []) {
      const d = choice.delta;
      const reasoning = d?.reasoning_content ?? d?.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (d?.content) yield* splitter.push(d.content);
      for (const tc of d?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const draft = drafts.get(index) ?? { name: '', arguments: '' };
        if (tc.id) draft.id = tc.id;
        if (tc.function?.name) draft.name += tc.function.name;
        if (tc.function?.arguments) draft.arguments += tc.function.arguments;
        drafts.set(index, draft);
      }
      if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason);
    }
    if (payload.usage) {
      if (payload.usage.prompt_tokens !== undefined)
        usage.promptTokens = payload.usage.prompt_tokens;
      if (payload.usage.completion_tokens !== undefined) {
        usage.completionTokens = payload.usage.completion_tokens;
      }
    }
    if (payload.timings) {
      const t = payload.timings;
      if (t.prompt_n !== undefined) usage.promptTokens = t.prompt_n;
      if (t.predicted_n !== undefined) usage.completionTokens = t.predicted_n;
      if (t.predicted_per_second !== undefined) usage.tokensPerSecond = t.predicted_per_second;
      if (t.prompt_ms !== undefined) usage.promptMs = t.prompt_ms;
    }
  }

  if (!sawDone && finish === undefined) {
    throw new ProviderError('E_BAD_RESPONSE', 'The stream ended before the model finished');
  }

  yield* splitter.flush();
  if (drafts.size > 0) {
    const calls: ToolCall[] = [...drafts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, d]) => ({ id: d.id ?? `call_${index}`, name: d.name, arguments: d.arguments }));
    yield { type: 'tool_calls', calls };
    finish = 'tool_calls';
  }
  yield { type: 'finish', reason: finish ?? 'stop', usage };
}

interface OpenAIModelList {
  data?: { id?: string; max_model_len?: number; context_length?: number }[];
}

export async function openAIListModels(
  ctx: OpenAIContext,
  timeoutMs?: number,
): Promise<ModelInfo[]> {
  const json = (await ctx.http.json(`${ctx.apiBase}/models`, {
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  })) as OpenAIModelList;
  if (!Array.isArray(json.data)) {
    throw new ProviderError('E_BAD_RESPONSE', 'Model list is missing `data`');
  }
  return json.data
    .filter((m): m is typeof m & { id: string } => typeof m.id === 'string')
    .map((m) => {
      const info: ModelInfo = { id: m.id, name: m.id, instanceId: ctx.instanceId };
      const ctxLen = m.max_model_len ?? m.context_length;
      if (typeof ctxLen === 'number') info.contextLength = ctxLen;
      if (/embed/i.test(m.id)) info.kind = 'embeddings';
      return info;
    });
}

export async function openAIEmbed(
  ctx: OpenAIContext,
  texts: string[],
  model: string,
): Promise<number[][]> {
  const json = (await ctx.http.json(`${ctx.apiBase}/embeddings`, {
    method: 'POST',
    body: JSON.stringify({ model, input: texts }),
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
  })) as { data?: { embedding: number[]; index?: number }[] };
  if (!Array.isArray(json.data))
    throw new ProviderError('E_BAD_RESPONSE', 'Embedding response is missing `data`');
  return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}
