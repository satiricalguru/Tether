import { useQuery } from '@tanstack/react-query';
import { estimateTokens } from '@/chat/request';
import { allocate, truncateToTokens, windowBudget } from '@/context/budget';
import type { Attachment } from '@/context/attachments';
import { sendMessage } from '@/lib/messaging';
import type { MessageRecord } from '@/lib/db';
import type { Settings } from '@/lib/settings';

export interface ContextBudget {
  window: number;
  available: number;
  attached: number;
  /** Attachments as they'll be sent (trimmed to fit). */
  fitted: Attachment[];
  truncated: boolean;
  /** Share of the window the attachments will occupy. */
  fraction: number;
}

/** Live budget for drafted context against the model's effective window. */
export function useContextBudget(opts: {
  instanceId: string | undefined;
  model: string | undefined;
  settings: Settings | undefined;
  thread: MessageRecord[];
  attachments: Attachment[];
  question: string;
}): ContextBudget | null {
  const caps = useQuery({
    queryKey: ['providers', 'caps', opts.instanceId, opts.model],
    queryFn: () =>
      sendMessage('bg:providers:capabilities', {
        instanceId: opts.instanceId ?? '',
        model: opts.model ?? '',
      }),
    enabled: !!opts.instanceId && !!opts.model,
    staleTime: 60_000,
  });
  if (!opts.settings) return null;
  const g = opts.settings.generation;
  const modelMax = caps.data?.contextLength ?? 8192;
  const window = g.numCtx > 0 ? Math.min(g.numCtx, modelMax) : modelMax;
  const fixed =
    estimateTokens(opts.settings.systemPrompt) +
    600 + // untrusted-content rule, fences, framing
    estimateTokens(opts.question) +
    opts.thread.reduce((n, m) => n + estimateTokens(m.content), 0);
  const b = windowBudget({ window, maxTokens: g.maxTokens, fixedTokens: fixed });
  return fitAttachments(opts.attachments, b.available, window);
}

export function fitAttachments(
  attachments: Attachment[],
  available: number,
  window: number,
): ContextBudget {
  const shares = allocate(
    attachments.map((a) => ({ id: a.id, tokens: a.tokens })),
    available,
  );
  let truncated = false;
  const fitted = attachments.map((a) => {
    const share = shares.get(a.id) ?? 0;
    if (a.tokens <= share) return a;
    truncated = true;
    const t = truncateToTokens(a.text, share);
    return { ...a, text: t.text, tokens: t.tokens, originalTokens: a.tokens };
  });
  const attached = fitted.reduce((n, a) => n + a.tokens, 0);
  return {
    window,
    available,
    attached,
    fitted,
    truncated,
    fraction: window ? attached / window : 0,
  };
}
