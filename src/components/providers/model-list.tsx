import { FlaskConical, PowerOff } from 'lucide-react';
import { useState } from 'react';
import { RunOutput } from '@/components/chat/run-output';
import { CapabilityBadges, modelDetail } from '@/components/models/model-badges';
import { Button } from '@/components/ui/button';
import { useChatRun } from '@/hooks/use-chat-run';
import { useModels, useUnloadModel } from '@/hooks/use-providers';
import { formatBytes } from '@/lib/format';
import type { ProviderKind } from '@/providers/types';

const TEST_PROMPT = 'Reply with one short friendly sentence confirming you are working.';

export function ModelList({ instanceId, kind }: { instanceId: string; kind: ProviderKind }) {
  const models = useModels(instanceId);
  const unload = useUnloadModel();
  const run = useChatRun();
  const [testing, setTesting] = useState<string>();

  if (models.isPending) return <p className="text-xs text-muted">Loading models…</p>;
  if (models.isError) return <p className="text-xs text-danger">{models.error.message}</p>;
  if (models.data.length === 0) {
    return (
      <p className="text-xs text-muted">
        No models installed.{' '}
        {kind === 'ollama' && (
          <>
            Try <code className="font-mono">ollama pull llama3.2</code>.
          </>
        )}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border" data-testid={`models-${instanceId}`}>
      {models.data.map((m) => (
        <li key={m.id} className="py-2">
          <div className="flex items-center gap-2">
            <span
              className={`size-1.5 shrink-0 rounded-full ${m.loaded ? 'bg-ok' : 'bg-border'}`}
              title={m.loaded ? 'Loaded in memory' : 'Not loaded'}
            />
            <span className="min-w-0 truncate text-sm font-medium">{m.name}</span>
            <CapabilityBadges model={m} />
            <span className="ml-auto flex shrink-0 gap-1">
              {m.loaded && kind === 'ollama' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Unload ${m.name}`}
                  onClick={() => unload.mutate({ instanceId, model: m.id })}
                >
                  <PowerOff />
                </Button>
              )}
              {m.kind !== 'embeddings' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={run.state.phase === 'running'}
                  onClick={() => {
                    setTesting(m.id);
                    void run.start({
                      instanceId,
                      model: m.id,
                      messages: [{ role: 'user', content: TEST_PROMPT }],
                      options: { maxTokens: 64, temperature: 0.2 },
                    });
                  }}
                >
                  <FlaskConical /> Test
                </Button>
              )}
            </span>
          </div>
          <p className="mt-0.5 pl-3.5 text-[11px] text-muted">
            {[modelDetail(m), m.sizeBytes ? formatBytes(m.sizeBytes) : undefined]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {testing === m.id && (
            <div className="mt-2 pl-3.5">
              <RunOutput state={run.state} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
