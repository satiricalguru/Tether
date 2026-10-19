import { HEALTH_TIMEOUT_MS, WrongServerError, probeHealth, type AdapterDeps } from './adapter';
import { ProviderError } from './http';
import { isToolsRejection, openAIChat, openAIEmbed, toolsUnsupported } from './openai-core';
import { ndjsonRecords } from './stream';
import { ThinkSplitter } from './think';
import {
  DEFAULT_CAPABILITIES,
  messageImages,
  messageText,
  type Capabilities,
  type ChatChunk,
  type ChatRequest,
  type FinishReason,
  type ModelInfo,
  type Provider,
  type ProviderConfig,
  type ToolCall,
} from './types';

interface OllamaDetails {
  family?: string;
  families?: string[] | null;
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaTag {
  name: string;
  model?: string;
  size?: number;
  details?: OllamaDetails;
}

interface OllamaShow {
  capabilities?: string[];
  details?: OllamaDetails;
  model_info?: Record<string, unknown>;
  template?: string;
  projector_info?: Record<string, unknown>;
}

interface OllamaChatRecord {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
}

/** Ollama treats "llama3.2" and "llama3.2:latest" as the same model. */
export function canonicalOllamaName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

export function contextLengthFromModelInfo(
  info: Record<string, unknown> | undefined,
): number | undefined {
  if (!info) return undefined;
  const arch = info['general.architecture'];
  if (typeof arch === 'string') {
    const v = info[`${arch}.context_length`];
    if (typeof v === 'number') return v;
  }
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && typeof v === 'number') return v;
  }
  return undefined;
}

export function capabilitiesFromShow(show: OllamaShow): Capabilities {
  const caps = show.capabilities;
  const has = (c: string) => caps?.includes(c) ?? false;
  // Ollama < 0.6 has no `capabilities`: infer from template and projector.
  const tools = caps ? has('tools') : /\.Tools\b/.test(show.template ?? '');
  const vision = caps ? has('vision') : !!show.projector_info;
  const out: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    nativeTools: tools,
    vision,
    jsonMode: true,
    jsonSchema: true,
    grammar: false,
    contextLength:
      contextLengthFromModelInfo(show.model_info) ?? DEFAULT_CAPABILITIES.contextLength,
    thinking: has('thinking'),
  };
  if (show.details?.quantization_level) out.quantization = show.details.quantization_level;
  if (caps && has('embedding') && !has('completion')) out.embedding = true;
  return out;
}

function toOllamaMessages(req: ChatRequest): Record<string, unknown>[] {
  return req.messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: messageText(m.content) };
    const images = messageImages(m.content);
    if (images.length) out.images = images.map((i) => i.data);
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => {
        let args: unknown;
        try {
          args = JSON.parse(c.arguments || '{}');
        } catch {
          args = {};
        }
        return { function: { name: c.name, arguments: args } };
      });
    }
    if (m.role === 'tool' && m.name) out.tool_name = m.name;
    return out;
  });
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function buildOllamaBody(req: ChatRequest): Record<string, unknown> {
  const o = req.options ?? {};
  const rf = req.responseFormat;
  return compact({
    model: req.model,
    messages: toOllamaMessages(req),
    stream: true,
    tools: req.tools?.length
      ? req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined,
    think: req.think,
    format: rf?.type === 'json' ? 'json' : rf?.type === 'json_schema' ? rf.schema : undefined,
    options: compact({
      temperature: o.temperature,
      top_p: o.topP,
      num_ctx: o.numCtx,
      num_predict: o.maxTokens,
      seed: o.seed,
      stop: o.stop?.length ? o.stop : undefined,
    }),
  });
}

function mapDoneReason(reason: string | undefined): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return reason ? 'unknown' : 'stop';
}

export function createOllama(config: ProviderConfig, deps: AdapterDeps): Provider {
  const base = config.baseUrl;
  const { http, overrides } = deps;
  const compatCtx = {
    http,
    apiBase: `${base}/v1`,
    instanceId: config.instanceId,
    overrides,
  };

  async function* nativeChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    const sentTools = !!req.tools?.length;
    let res: Response;
    try {
      res = await http.request(`${base}/api/chat`, {
        method: 'POST',
        body: JSON.stringify(buildOllamaBody(req)),
        signal,
      });
    } catch (err) {
      const msg = err instanceof ProviderError ? (err.serverMessage ?? '') : '';
      if (req.think && /does not support thinking/i.test(msg)) {
        await overrides.set(config.instanceId, req.model, { thinking: false });
        yield* nativeChat({ ...req, think: undefined }, signal);
        return;
      }
      if (isToolsRejection(err, sentTools) && (/tool/i.test(msg) || !msg)) {
        await overrides.set(config.instanceId, req.model, { nativeTools: false });
        throw toolsUnsupported(req.model, err);
      }
      throw err;
    }
    if (!res.body) throw new ProviderError('E_BAD_RESPONSE', 'Empty response body');

    const splitter = new ThinkSplitter();
    const calls: ToolCall[] = [];
    for await (const raw of ndjsonRecords(res.body, { signal })) {
      const rec = raw as OllamaChatRecord;
      if (rec.error) {
        throw new ProviderError('E_HTTP', `Model error: ${rec.error}`, {
          serverMessage: rec.error,
        });
      }
      const m = rec.message;
      if (m?.thinking) yield { type: 'reasoning', text: m.thinking };
      if (m?.content) yield* splitter.push(m.content);
      for (const tc of m?.tool_calls ?? []) {
        const args = tc.function?.arguments;
        calls.push({
          id: tc.id ?? `call_${calls.length}`,
          name: tc.function?.name ?? '',
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        });
      }
      if (rec.done) {
        yield* splitter.flush();
        if (calls.length) yield { type: 'tool_calls', calls };
        const evalSeconds = (rec.eval_duration ?? 0) / 1e9;
        yield {
          type: 'finish',
          reason: calls.length ? 'tool_calls' : mapDoneReason(rec.done_reason),
          usage: compact({
            promptTokens: rec.prompt_eval_count,
            completionTokens: rec.eval_count,
            tokensPerSecond:
              rec.eval_count && evalSeconds > 0 ? rec.eval_count / evalSeconds : undefined,
            loadMs: rec.load_duration === undefined ? undefined : rec.load_duration / 1e6,
            promptMs:
              rec.prompt_eval_duration === undefined ? undefined : rec.prompt_eval_duration / 1e6,
          }),
        };
        return;
      }
    }
    throw new ProviderError('E_BAD_RESPONSE', 'The stream ended before the model finished');
  }

  return {
    id: 'ollama',
    instanceId: config.instanceId,
    label: config.label,
    baseUrl: base,

    health: () =>
      probeHealth(async () => {
        const json = (await http.json(`${base}/api/version`, {
          timeoutMs: HEALTH_TIMEOUT_MS,
        })) as { version?: unknown };
        if (typeof json.version !== 'string') throw new WrongServerError('Ollama');
        return json.version;
      }),

    async listModels(): Promise<ModelInfo[]> {
      const [tags, ps] = await Promise.all([
        http.json(`${base}/api/tags`) as Promise<{ models?: OllamaTag[] }>,
        (http.json(`${base}/api/ps`) as Promise<{ models?: OllamaTag[] }>).catch(() => ({
          models: [],
        })),
      ]);
      const hot = new Set((ps.models ?? []).map((m) => canonicalOllamaName(m.name)));
      return (tags.models ?? []).map((t) => {
        const info: ModelInfo = {
          id: t.name,
          name: t.name,
          instanceId: config.instanceId,
          loaded: hot.has(canonicalOllamaName(t.name)),
        };
        if (t.details?.parameter_size) info.parameterSize = t.details.parameter_size;
        if (t.details?.quantization_level) info.quantization = t.details.quantization_level;
        if (t.details?.family) info.family = t.details.family;
        if (t.size !== undefined) info.sizeBytes = t.size;
        const families = [t.details?.family, ...(t.details?.families ?? [])].join(' ');
        if (/bert|embed/i.test(`${families} ${t.name}`)) info.kind = 'embeddings';
        return info;
      });
    },

    async capabilities(model: string): Promise<Capabilities> {
      const show = (await http.json(`${base}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      })) as OllamaShow;
      return { ...capabilitiesFromShow(show), ...(await overrides.get(config.instanceId, model)) };
    },

    chat(req, signal) {
      if (config.useOpenAICompat) {
        return openAIChat(compatCtx, req, signal, {
          jsonModeAs: 'json_object',
          streamUsage: true,
        });
      }
      return nativeChat(req, signal);
    },

    async embed(texts, model) {
      if (config.useOpenAICompat) return openAIEmbed(compatCtx, texts, model);
      const json = (await http.json(`${base}/api/embed`, {
        method: 'POST',
        body: JSON.stringify({ model, input: texts }),
      })) as { embeddings?: number[][] };
      if (!Array.isArray(json.embeddings)) {
        throw new ProviderError('E_BAD_RESPONSE', 'Embedding response is missing `embeddings`');
      }
      return json.embeddings;
    },

    async unload(model) {
      await http.json(`${base}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    },

    async isLoaded(model) {
      try {
        const ps = (await http.json(`${base}/api/ps`, { timeoutMs: HEALTH_TIMEOUT_MS })) as {
          models?: OllamaTag[];
        };
        const want = canonicalOllamaName(model);
        return (ps.models ?? []).some((m) => canonicalOllamaName(m.name) === want);
      } catch {
        return undefined;
      }
    },
  };
}
