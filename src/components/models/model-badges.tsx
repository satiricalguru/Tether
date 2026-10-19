import { Badge } from '@/components/ui/badge';
import type { ModelInfo } from '@/providers/types';
import { formatTokens } from '@/lib/format';

export function modelDetail(m: ModelInfo): string {
  return [
    m.parameterSize,
    m.quantization,
    m.contextLength ? `${formatTokens(m.contextLength)} ctx` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function CapabilityBadges({ model }: { model: ModelInfo }) {
  const c = model.capabilities;
  if (!c) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {c.embedding && <Badge>embeddings</Badge>}
      {c.nativeTools && <Badge tone="accent">tools</Badge>}
      {c.vision && <Badge tone="accent">vision</Badge>}
      {c.thinking && <Badge tone="accent">thinking</Badge>}
      {c.grammar && <Badge>grammar</Badge>}
    </span>
  );
}
