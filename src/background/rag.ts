import type { Attachment } from '@/context/attachments';
import { getDb, newId, type EmbeddingRecord } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import type { HandlerMap } from '@/lib/messaging';
import { getSettings } from '@/lib/settings';
import type { ProviderRegistry } from '@/providers/registry';
import type { ModelInfo } from '@/providers/types';
import type { Chunk } from '@/rag/chunk';
import { fitByRetrieval, retrievable, truncateFallback } from '@/rag/fit';
import type { Vector } from '@/rag/vector';

/**
 * Local RAG in the background: picks an embedding model on the
 * conversation's provider, embeds chunks (cached in IndexedDB by url +
 * content hash + model) and fits long attachments to their token share.
 * Anything that goes wrong falls back to cutting from the top, and says so.
 */

const log = createLogger('rag');

/** Known good small embedding models, best first. */
const PREFERRED = ['nomic-embed-text', 'bge-m3', 'embeddinggemma'];

const isEmbedding = (m: ModelInfo) => m.kind === 'embeddings' || m.capabilities?.embedding === true;

/** The configured model if installed, else the first preferred one installed, else any embedding model. */
export function pickEmbeddingModel(models: ModelInfo[], configured: string): string | undefined {
  if (configured) return models.some((m) => m.id === configured) ? configured : undefined;
  for (const name of PREFERRED) {
    const hit = models.find(
      (m) => m.id === name || m.id.startsWith(`${name}:`) || m.id.includes(name),
    );
    if (hit) return hit.id;
  }
  return models.find(isEmbedding)?.id;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BATCH = 16;

/** Chunk vectors from the cache, embedding (and storing) them on a miss. */
export async function cachedChunkVectors(
  key: { url: string; contentHash: string; model: string },
  chunks: Chunk[],
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<Vector[]> {
  const db = getDb();
  const hit = await db.embeddings
    .where('[url+contentHash+model]')
    .equals([key.url, key.contentHash, key.model])
    .toArray();
  if (hit.length === chunks.length) {
    return hit.sort((a, b) => a.chunkIndex - b.chunkIndex).map((r) => r.vector);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    vectors.push(...(await embed(chunks.slice(i, i + BATCH).map((c) => c.text))));
  }
  if (vectors.length !== chunks.length) throw new Error('embedding count mismatch');
  const records: EmbeddingRecord[] = chunks.map((c, i) => ({
    id: newId(),
    ...key,
    chunkIndex: c.index,
    text: c.text,
    vector: Float32Array.from(vectors[i] ?? []),
  }));
  await db.transaction('rw', db.embeddings, async () => {
    // One version of a page's content per model: vectors for older content
    // go, as do partial rows for this key (other chunk sizes stay).
    const content = key.contentHash.split('@')[0] ?? key.contentHash;
    await db.embeddings
      .where('url')
      .equals(key.url)
      .filter(
        (r) =>
          r.model === key.model &&
          ((r.contentHash.split('@')[0] ?? '') !== content || r.contentHash === key.contentHash),
      )
      .delete();
    await db.embeddings.bulkAdd(records);
  });
  return vectors;
}

export interface FitItem {
  attachment: Attachment;
  /** Tokens this attachment may use. */
  share: number;
}

/**
 * Retrieval-trained models expect their task prefixes on every input; without
 * them, query and document vectors land in different regions. These are the
 * model cards' own strings.
 */
export function taskPrefixes(model: string): { document: string; query: string } | null {
  if (/nomic-embed/i.test(model)) return { document: 'search_document: ', query: 'search_query: ' };
  if (/embeddinggemma/i.test(model))
    return { document: 'title: none | text: ', query: 'task: search result | query: ' };
  return null;
}

export function ragHandlers(registry: ProviderRegistry): HandlerMap {
  const modelFor = async (instanceId: string): Promise<string | undefined> => {
    const s = await getSettings();
    if (!s.rag.enabled) return undefined;
    const models = await registry.models(instanceId).catch(() => []);
    return pickEmbeddingModel(models, s.rag.embeddingModel);
  };

  return {
    'bg:rag:status': async ({ instanceId }) => {
      const s = await getSettings();
      if (!s.rag.enabled) return { enabled: false };
      const model = await modelFor(instanceId);
      return model ? { enabled: true, model } : { enabled: true };
    },
    'bg:rag:fit': async ({ instanceId, question, items }) => {
      const s = await getSettings();
      const model = s.rag.enabled ? await modelFor(instanceId) : undefined;
      const provider = model
        ? await registry.provider(instanceId).catch(() => undefined)
        : undefined;
      const embed = provider?.embed?.bind(provider);
      return Promise.all(
        items.map(async ({ attachment: a, share }) => {
          if (a.tokens <= share) return a;
          if (!retrievable(a)) return truncateFallback(a, share);
          if (!s.rag.enabled) return truncateFallback(a, share, { fallback: 'off' });
          if (!model || !embed) return truncateFallback(a, share, { fallback: 'no-model' });
          try {
            const contentHash = await sha256(a.text);
            const url = a.url ?? `attachment:${a.kind}:${a.title}`;
            const task = taskPrefixes(model);
            return await fitByRetrieval(a, share, question, {
              model,
              // The chunk size and task prefix are part of what was embedded.
              embedChunks: (chunks, size) =>
                cachedChunkVectors(
                  { url, contentHash: `${contentHash}@${size}${task ? '@task' : ''}`, model },
                  chunks,
                  (t) =>
                    embed(
                      t.map((x) => `${task?.document ?? ''}${x}`),
                      model,
                    ),
                ),
              embedQuery: async (q) => (await embed([`${task?.query ?? ''}${q}`], model))[0] ?? [],
            });
          } catch (err) {
            log.warn('retrieval failed; cutting from the top instead', err);
            return truncateFallback(a, share, {
              fallback: 'failed',
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    },
  };
}
