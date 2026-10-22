import { useQuery } from '@tanstack/react-query';
import { Card, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { useSettings } from '@/hooks/use-settings';
import { sendMessage } from '@/lib/messaging';
import { SwitchRow } from './fields';

/** Local RAG: find the relevant parts of long pages with an embedding model. */
export function RagCard() {
  const { settings, update } = useSettings();
  const instanceId = settings?.selection.instanceId ?? '';
  const models = useQuery({
    queryKey: ['providers', 'models', instanceId],
    queryFn: () => sendMessage('bg:providers:models', { instanceId }),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
  const status = useQuery({
    queryKey: ['rag', 'status', instanceId, settings?.rag.enabled, settings?.rag.embeddingModel],
    queryFn: () => sendMessage('bg:rag:status', { instanceId }),
    enabled: !!instanceId,
  });
  if (!settings) return null;
  const embedding = (models.data ?? []).filter(
    (m) => m.kind === 'embeddings' || m.capabilities?.embedding === true,
  );
  const configured = settings.rag.embeddingModel;

  return (
    <Card>
      <CardTitle>Long pages and PDFs</CardTitle>
      <SwitchRow
        label="Find the relevant parts of long pages"
        description="When a page or PDF is too long for the model, send the sections that match your question instead of the start. Uses an embedding model on your own server; nothing leaves your machine."
        checked={settings.rag.enabled}
        onChange={(v) => void update({ rag: { enabled: v } })}
      />
      <div className="mt-2 max-w-xs">
        <Label htmlFor="rag-model">Embedding model</Label>
        <select
          id="rag-model"
          className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
          value={configured}
          disabled={!settings.rag.enabled}
          onChange={(e) => void update({ rag: { embeddingModel: e.target.value } })}
        >
          <option value="">Automatic</option>
          {configured && !embedding.some((m) => m.id === configured) && (
            <option value={configured}>{configured} (not installed)</option>
          )}
          {embedding.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-muted" data-testid="rag-status">
          {!settings.rag.enabled
            ? 'Off: long content is cut from the start.'
            : status.data?.model
              ? `Using ${status.data.model}.`
              : status.isSuccess
                ? 'No embedding model found on the selected server, so long content is cut from the start. Install one with: ollama pull nomic-embed-text'
                : 'Automatic picks nomic-embed-text, bge-m3 or embeddinggemma if installed.'}
        </p>
      </div>
    </Card>
  );
}
