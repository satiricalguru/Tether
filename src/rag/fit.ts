import { truncateToTokens } from '@/context/budget';
import type { Attachment, Retrieval } from '@/context/attachments';
import { estimateTokens } from '@/context/tokens';
import { chunkText, type Chunk } from './chunk';
import { mmr, type Vector } from './vector';

/**
 * Fit long page/PDF text into a token share by sending the chunks most
 * relevant to the question, in document order, instead of the first N
 * tokens. Pure: embedding (and its cache) is passed in.
 */

export interface RetrievalDeps {
  model: string;
  /** Vectors for every chunk, in order (cached by the caller). */
  embedChunks: (chunks: Chunk[], size: number) => Promise<Vector[]>;
  embedQuery: (text: string) => Promise<Vector>;
}

/**
 * Chunk size for a token share: 800 (the spec's size) when several fit,
 * smaller for small windows. Sizes snap to a few tiers, so a page keeps
 * the same chunks (and cached vectors) as the share drifts between turns.
 */
export function chunkSize(share: number): number {
  if (share >= 2400) return 800;
  if (share >= 1200) return 400;
  if (share >= 600) return 200;
  return 120;
}

/** Gaps between kept chunks. */
export const GAP = '[…]';

export const retrievalHeader = (kept: number, total: number) =>
  `[Long content: showing the ${kept} of ${total} sections most relevant to the question, in their original order; ${GAP} marks left-out text.]`;

/** Attachment kinds long enough to need retrieval. */
export function retrievable(a: Attachment): boolean {
  return a.kind === 'page' || a.kind === 'tab' || a.kind === 'pdf';
}

/** Head truncation (the old behaviour), recording why retrieval wasn't used. */
export function truncateFallback(a: Attachment, share: number, why?: Retrieval): Attachment {
  if (a.tokens <= share) return a;
  const t = truncateToTokens(a.text, share);
  return {
    ...a,
    text: t.text,
    tokens: t.tokens,
    originalTokens: a.tokens,
    ...(why ? { retrieval: why } : {}),
  };
}

export async function fitByRetrieval(
  a: Attachment,
  share: number,
  question: string,
  deps: RetrievalDeps,
): Promise<Attachment> {
  if (a.tokens <= share) return a;
  const size = chunkSize(share);
  const chunks = chunkText(a.text, { size, overlap: 0.15 });
  if (chunks.length <= 1)
    return truncateFallback(a, share, { fallback: 'failed', reason: 'too short to split' });
  const [vectors, query] = await Promise.all([
    deps.embedChunks(chunks, size),
    deps.embedQuery(question),
  ]);
  if (vectors.length !== chunks.length) throw new Error('embedding count mismatch');

  const header = retrievalHeader(0, 0);
  let used = estimateTokens(header) + 8;
  const keep: number[] = [];
  for (const i of mmr(query, vectors, chunks.length, 0.7)) {
    const c = chunks[i];
    if (!c) continue;
    const cost = c.tokens + 2;
    if (used + cost > share) continue;
    keep.push(i);
    used += cost;
  }
  if (keep.length === 0) {
    return truncateFallback(a, share, { fallback: 'failed', reason: 'no section fits the space' });
  }
  keep.sort((x, y) => x - y);
  const parts: string[] = [];
  keep.forEach((i, n) => {
    const prev = n > 0 ? keep[n - 1] : -1;
    if (prev !== undefined && i - prev > 1) parts.push(GAP);
    parts.push(chunks[i]?.text ?? '');
  });
  if ((keep.at(-1) ?? 0) < chunks.length - 1) parts.push(GAP);
  const text = `${retrievalHeader(keep.length, chunks.length)}\n\n${parts.join('\n\n')}`;
  return {
    ...a,
    text,
    tokens: estimateTokens(text),
    originalTokens: a.tokens,
    retrieval: { model: deps.model, kept: keep.length, total: chunks.length },
  };
}
