/**
 * The provider contract every local backend implements (spec §4.1), plus the
 * normalized chat stream shape the rest of Tether consumes.
 */

export type ProviderKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'openai-compatible';

/** A configured endpoint. Several can share a kind (e.g. vLLM and Jan). */
export interface ProviderConfig {
  instanceId: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** OpenAI-compatible servers only. Stored locally, never logged. */
  apiKey: string;
  /** Ollama only: talk to /v1/chat/completions instead of /api/chat. */
  useOpenAICompat: boolean;
}

export interface Capabilities {
  nativeTools: boolean;
  vision: boolean;
  jsonMode: boolean;
  jsonSchema: boolean;
  grammar: boolean;
  contextLength: number;
  quantization?: string;
  thinking?: boolean;
  /** Embedding-only model: can't chat. */
  embedding?: boolean;
  /** Server honours `stream_options.include_usage` (OpenAI-style APIs). */
  streamUsage?: boolean;
}

export interface ModelInfo {
  id: string;
  /** Display name; often equal to id. */
  name: string;
  instanceId: string;
  /** Currently resident in memory ("hot"): selecting it avoids a cold load. */
  loaded?: boolean;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  sizeBytes?: number;
  contextLength?: number;
  kind?: 'llm' | 'vlm' | 'embeddings';
  capabilities?: Capabilities;
}

export type Diagnosis =
  | 'ok'
  | 'unreachable'
  | 'timeout'
  | 'origin-blocked'
  | 'needs-permission'
  | 'auth-required'
  | 'http-error'
  | 'bad-response';

export interface HealthResult {
  ok: boolean;
  version?: string;
  latencyMs: number;
  diagnosis: Diagnosis;
  /** Human-readable detail for the Doctor (status code, server message). */
  detail?: string;
  status?: number;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Base64 without a data: prefix. */
  data: string;
  mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model; parsed by the tool harness. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  /** For role 'tool': which call this answers. */
  toolCallId?: string;
  /** For role 'tool': the tool's name (Ollama wants it). */
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerationOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Context window to request (Ollama num_ctx). */
  numCtx?: number;
  seed?: number;
  stop?: string[];
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown> };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  options?: GenerationOptions;
  tools?: ToolDefinition[];
  responseFormat?: ResponseFormat;
  /** GBNF grammar (llama.cpp). */
  grammar?: string;
  /** Ask reasoning models to think (Ollama `think`). */
  think?: boolean;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  /** Server-measured generation speed, when the server reports it. */
  tokensPerSecond?: number;
  /** Model load time reported by the server (Ollama load_duration). */
  loadMs?: number;
  /** Server-measured prompt processing time. */
  promptMs?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'error' | 'unknown';

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /**
   * The text emitted so far was actually reasoning: the model began thinking
   * without an opening tag and then closed it. Consumers move accumulated
   * text into reasoning.
   */
  | { type: 'reclassify-reasoning' }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'finish'; reason: FinishReason; usage: Usage };

export interface Provider {
  readonly id: ProviderKind;
  readonly instanceId: string;
  readonly label: string;
  readonly baseUrl: string;
  health(): Promise<HealthResult>;
  listModels(): Promise<ModelInfo[]>;
  capabilities(model: string): Promise<Capabilities>;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model: string): Promise<number[][]>;
  unload?(model: string): Promise<void>;
  /** undefined = unknown (backend can't tell us). */
  isLoaded?(model: string): Promise<boolean | undefined>;
  /**
   * The context window the server is actually running the model with, which
   * can be far below the model's maximum (Ollama defaults to a few thousand
   * tokens unless num_ctx is set). undefined = unknown or not loaded.
   */
  runtimeContext?(model: string): Promise<number | undefined>;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  nativeTools: false,
  vision: false,
  jsonMode: false,
  jsonSchema: false,
  grammar: false,
  contextLength: 4096,
};

/** Text content of a message, ignoring images. */
export function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function messageImages(content: ChatMessage['content']): ImagePart[] {
  return typeof content === 'string' ? [] : content.filter((p) => p.type === 'image');
}
