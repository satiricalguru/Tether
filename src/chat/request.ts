import type { ChatStreamRequest } from '@/background/chat';
import type { ConversationRecord, MessageRecord } from '@/lib/db';
import type { GenerationSettings, ReasoningMode } from '@/lib/settings';
import type { ChatMessage } from '@/providers/types';

/**
 * Builds the request for the next assistant turn from the visible thread.
 *
 * Invariants:
 *  - reasoning is never sent (it lives in its own field; small context
 *    windows can't afford it and it confuses the next turn);
 *  - errored and empty replies are skipped;
 *  - when over budget, the oldest turns go first; the system prompt and
 *    the latest user message always stay.
 */

/** Rough token estimate until Phase 3's counter: ~3.5 chars/token, plus framing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5) + 4;
}

export interface BuildInput {
  conversation: ConversationRecord;
  /** Root → the user message being answered. */
  thread: MessageRecord[];
  defaults: GenerationSettings;
  systemPrompt: string;
  reasoning: ReasoningMode;
  /** From capabilities: does the model support thinking / what is its window. */
  modelThinks: boolean;
  contextLength: number;
}

export interface BuiltRequest {
  request: ChatStreamRequest;
  /** Thread messages dropped to fit the window. */
  dropped: number;
  estimatedPromptTokens: number;
}

export function effectiveGeneration(conv: ConversationRecord, defaults: GenerationSettings) {
  return {
    temperature: conv.settings.temperature ?? defaults.temperature,
    maxTokens: conv.settings.maxTokens ?? defaults.maxTokens,
    topP: defaults.topP,
    numCtx: defaults.numCtx,
    seed: defaults.seed,
  };
}

export function buildRequest(input: BuildInput): BuiltRequest {
  const gen = effectiveGeneration(input.conversation, input.defaults);
  const system = (input.conversation.settings.systemPrompt ?? input.systemPrompt).trim();

  const turns: ChatMessage[] = input.thread
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.status !== 'error')
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Window we can fill: requested num_ctx (clamped to the model) minus the reply reserve.
  const window = gen.numCtx > 0 ? Math.min(gen.numCtx, input.contextLength) : input.contextLength;
  const budget = Math.max(256, window - gen.maxTokens);
  let used =
    (system ? estimateTokens(system) : 0) +
    turns.reduce((n, t) => n + estimateTokens(t.content as string), 0);
  let dropped = 0;
  // Keep at least the final user turn; drop from the front in pairs-ish order.
  while (used > budget && turns.length > 1) {
    const first = turns.shift();
    used -= estimateTokens((first?.content as string | undefined) ?? '');
    dropped += 1;
  }
  // A conversation must not start with an assistant turn after trimming.
  while (turns.length > 1 && turns[0]?.role === 'assistant') {
    const first = turns.shift();
    used -= estimateTokens((first?.content as string | undefined) ?? '');
    dropped += 1;
  }

  const messages: ChatMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...turns,
  ];

  const request: ChatStreamRequest = {
    instanceId: input.conversation.instanceId,
    model: input.conversation.model,
    messages,
    options: {
      temperature: gen.temperature,
      topP: gen.topP,
      maxTokens: gen.maxTokens,
      ...(gen.numCtx > 0 ? { numCtx: Math.min(gen.numCtx, input.contextLength) } : {}),
      ...(gen.seed >= 0 ? { seed: gen.seed } : {}),
    },
  };
  if (input.modelThinks && input.reasoning !== 'auto') request.think = input.reasoning === 'on';
  return { request, dropped, estimatedPromptTokens: used };
}
