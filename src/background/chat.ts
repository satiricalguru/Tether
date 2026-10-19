import { AsyncQueue } from '@/lib/async-queue';
import type { StreamHandler } from '@/lib/ports';
import type { ChatChunk, ChatRequest, FinishReason, Provider } from '@/providers/types';

/**
 * The `chat` stream: runs one generation against a provider and adds what
 * the UI needs that providers don't give us — status while waiting for the
 * first token (a cold model load can take a minute and must not look hung)
 * and normalized metrics.
 */

export type ChatStatus = 'waiting' | 'loading-model' | 'slow' | 'generating';

export type ChatStreamEvent = ChatChunk | { type: 'status'; status: ChatStatus };

export interface ChatStreamRequest extends ChatRequest {
  instanceId: string;
}

export interface ChatMetrics {
  ttftMs?: number;
  totalMs: number;
  tokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** True when the server didn't report usage and we counted chunks instead. */
  completionTokensEstimated: boolean;
  loadMs?: number;
  /** The window this request actually ran with (see Provider.runtimeContext). */
  contextLength?: number;
  /** The model's trained maximum, when larger than contextLength. */
  maxContextLength?: number;
  finishReason: FinishReason;
}

export interface ChatDone {
  metrics: ChatMetrics;
}

export interface ChatServiceDeps {
  getProvider: (instanceId: string) => Promise<Provider>;
  contextLength?: (instanceId: string, model: string) => Promise<number | undefined>;
  now?: () => number;
  /** Watchdog thresholds (ms without a first token). */
  thresholds?: { knownCold: number; unknown: number; knownHot: number };
}

const DEFAULT_THRESHOLDS = { knownCold: 1500, unknown: 3000, knownHot: 5000 };

export function createChatStream(deps: ChatServiceDeps): StreamHandler<'chat'> {
  const now = deps.now ?? (() => performance.now());
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;

  return async function* chat(req, { signal }) {
    const { instanceId, ...chatReq } = req;
    const provider = await deps.getProvider(instanceId);
    const started = now();
    const queue = new AsyncQueue<ChatStreamEvent>();
    let firstTokenAt: number | undefined;
    let finish: Extract<ChatChunk, { type: 'finish' }> | undefined;
    let chunkTokens = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    queue.push({ type: 'status', status: 'waiting' });

    // Was the model resident when we asked? Decides "loading model…" vs "thinking…".
    const loaded = provider.isLoaded
      ? provider.isLoaded(chatReq.model).catch(() => undefined)
      : Promise.resolve(undefined);
    void loaded.then((isLoaded) => {
      if (firstTokenAt !== undefined || signal.aborted) return;
      const wait =
        isLoaded === false
          ? thresholds.knownCold
          : isLoaded === true
            ? thresholds.knownHot
            : thresholds.unknown;
      const elapsed = now() - started;
      watchdog = setTimeout(
        () => {
          if (firstTokenAt === undefined && !signal.aborted) {
            queue.push({ type: 'status', status: isLoaded === true ? 'slow' : 'loading-model' });
          }
        },
        Math.max(0, wait - elapsed),
      );
    });

    const contextLength = deps.contextLength?.(instanceId, chatReq.model).catch(() => undefined);

    void (async () => {
      try {
        for await (const chunk of provider.chat(chatReq, signal)) {
          if (firstTokenAt === undefined && chunk.type !== 'finish') {
            firstTokenAt = now();
            clearTimeout(watchdog);
            queue.push({ type: 'status', status: 'generating' });
          }
          if (chunk.type === 'text' || chunk.type === 'reasoning') chunkTokens += 1;
          if (chunk.type === 'finish') finish = chunk;
          queue.push(chunk);
        }
        queue.end();
      } catch (err) {
        queue.fail(err);
      } finally {
        clearTimeout(watchdog);
      }
    })();

    for await (const event of queue) yield event;

    const end = now();
    const usage = finish?.usage ?? {};
    const completionTokens = usage.completionTokens ?? (chunkTokens || undefined);
    const genSeconds = firstTokenAt === undefined ? 0 : (end - firstTokenAt) / 1000;
    const metrics: ChatMetrics = {
      totalMs: Math.round(end - started),
      completionTokensEstimated: usage.completionTokens === undefined,
      finishReason: finish?.reason ?? 'unknown',
    };
    if (firstTokenAt !== undefined) metrics.ttftMs = Math.round(firstTokenAt - started);
    const tps =
      usage.tokensPerSecond ??
      (completionTokens && genSeconds > 0 ? completionTokens / genSeconds : undefined);
    if (tps !== undefined) metrics.tokensPerSecond = Math.round(tps * 10) / 10;
    if (usage.promptTokens !== undefined) metrics.promptTokens = usage.promptTokens;
    if (completionTokens !== undefined) metrics.completionTokens = completionTokens;
    if (usage.loadMs !== undefined) metrics.loadMs = Math.round(usage.loadMs);
    // Effective window: what we asked for, else what the server is running
    // with, else the model's maximum.
    const max = await contextLength;
    const runtime =
      chatReq.options?.numCtx ??
      (await provider.runtimeContext?.(chatReq.model).catch(() => undefined));
    const effective = runtime ?? max;
    if (effective !== undefined) metrics.contextLength = effective;
    if (max !== undefined && effective !== undefined && max > effective)
      metrics.maxContextLength = max;
    return { metrics };
  };
}
