import type { ChatMetrics } from '@/background/chat';
import { formatMs, formatTokens } from '@/lib/format';

/** TTFT · tok/s · prompt tokens · context used/max · load time. */
export function MetricsFooter({ metrics }: { metrics: ChatMetrics }) {
  const used = (metrics.promptTokens ?? 0) + (metrics.completionTokens ?? 0);
  const items: [string, string][] = [];
  if (metrics.ttftMs !== undefined) items.push(['TTFT', formatMs(metrics.ttftMs)]);
  if (metrics.tokensPerSecond !== undefined)
    items.push(['tok/s', metrics.tokensPerSecond.toFixed(1)]);
  if (metrics.promptTokens !== undefined) items.push(['prompt', `${metrics.promptTokens} tok`]);
  if (used > 0 && metrics.contextLength) {
    items.push([
      'context',
      `${formatTokens(used)} / ${formatTokens(metrics.contextLength)} (${Math.max(1, Math.round((used / metrics.contextLength) * 100))}%)`,
    ]);
    if (metrics.maxContextLength) items.push(['model max', formatTokens(metrics.maxContextLength)]);
  }
  if (metrics.loadMs) items.push(['load', formatMs(metrics.loadMs)]);
  return (
    <dl
      className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted"
      data-testid="metrics"
    >
      {items.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt>{k}</dt>
          <dd className="text-fg">{v}</dd>
        </div>
      ))}
      {metrics.completionTokensEstimated && metrics.completionTokens !== undefined && (
        <div title="The server didn't report usage; tokens were counted from stream chunks.">
          ≈ estimated
        </div>
      )}
    </dl>
  );
}
