import { beforeEach, describe, expect, it } from 'vitest';
import { cachedChunkVectors, pickEmbeddingModel } from '@/background/rag';
import type { Attachment } from '@/context/attachments';
import { estimateTokens } from '@/context/tokens';
import { getDb } from '@/lib/db';
import type { ModelInfo } from '@/providers/types';
import { chunkText } from '@/rag/chunk';
import { chunkSize, fitByRetrieval, GAP, truncateFallback } from '@/rag/fit';
import { mockEmbedding } from '../fixtures/mock-llm/server';

const filler = (topic: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `The ${topic} section, line ${i}, covers ${topic} in general.`,
  ).join(' ');

const LONG = [
  '# Visitor guide',
  '## Trails',
  filler('trails', 40),
  '## Camping',
  filler('camping', 40),
  '## Wildlife',
  filler('wildlife', 40),
  '## Parking',
  `${filler('parking', 20)} The overnight parking permit fee is $23 and is paid at the ranger kiosk.`,
].join('\n\n');

function page(text = LONG): Attachment {
  return {
    id: 'p',
    kind: 'page',
    title: 'Guide',
    url: 'https://park.test/guide',
    text,
    tokens: estimateTokens(text),
    warnings: [],
  };
}

const deps = (calls: string[][] = []) => ({
  model: 'nomic-embed-text:latest',
  embedChunks: (chunks: { text: string }[]) => {
    calls.push(chunks.map((c) => c.text));
    return Promise.resolve(chunks.map((c) => mockEmbedding(c.text)));
  },
  embedQuery: (q: string) => {
    calls.push([q]);
    return Promise.resolve(mockEmbedding(q));
  },
});

describe('fitByRetrieval', () => {
  it('keeps the section that answers the question, though it is at the end', async () => {
    const a = page();
    const share = Math.floor(a.tokens / 4);
    const out = await fitByRetrieval(a, share, 'What is the overnight parking permit fee?', deps());
    expect(out.text).toContain('$23');
    expect(out.tokens).toBeLessThanOrEqual(share);
    expect(out.originalTokens).toBe(a.tokens);
    expect(out.retrieval).toMatchObject({ model: 'nomic-embed-text:latest' });
    expect(out.text.startsWith('[Long content: showing the')).toBe(true);
    expect(out.text).toContain(GAP);
    // Head truncation would have lost it.
    expect(truncateFallback(a, share).text).not.toContain('$23');
  });

  it('keeps chunks in document order', async () => {
    const a = page();
    const out = await fitByRetrieval(a, Math.floor(a.tokens / 2), 'camping and parking', deps());
    const camping = out.text.indexOf('camping section');
    const parking = out.text.indexOf('parking section');
    expect(camping).toBeGreaterThan(-1);
    expect(parking).toBeGreaterThan(camping);
  });

  it('leaves text that already fits alone', async () => {
    const a = page('Short page.');
    const calls: string[][] = [];
    expect(await fitByRetrieval(a, 1000, 'q', deps(calls))).toBe(a);
    expect(calls).toEqual([]);
  });

  it('falls back to the start when the text can’t be split, and says why', async () => {
    const a = page(filler('one', 3));
    const out = await fitByRetrieval(a, 10, 'q', deps());
    expect(out.retrieval).toMatchObject({ fallback: 'failed' });
  });

  it('truncateFallback records the reason only when given one', () => {
    const a = page();
    expect(truncateFallback(a, 100, { fallback: 'no-model' }).retrieval).toEqual({
      fallback: 'no-model',
    });
    expect(truncateFallback(a, 100).retrieval).toBeUndefined();
  });
});

describe('chunkSize', () => {
  it('is 800 tokens when several fit, and snaps to tiers below that', () => {
    expect(chunkSize(5000)).toBe(800);
    expect(chunkSize(2400)).toBe(800);
    expect(chunkSize(1500)).toBe(400);
    expect(chunkSize(700)).toBe(200);
    expect(chunkSize(650)).toBe(chunkSize(610));
    expect(chunkSize(100)).toBe(120);
  });

  it('passes the size to embedChunks, for the cache key', async () => {
    const sizes: number[] = [];
    const a = page();
    await fitByRetrieval(a, 700, 'parking', {
      ...deps(),
      embedChunks: (cs, size) => {
        sizes.push(size);
        return Promise.resolve(cs.map((c) => mockEmbedding(c.text)));
      },
    });
    expect(sizes).toEqual([200]);
  });
});

describe('pickEmbeddingModel', () => {
  const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
    id,
    name: id,
    instanceId: 'o',
    ...extra,
  });
  it('prefers the configured model, then known ones, then any embedding model', () => {
    const models = [
      m('llama3:8b'),
      m('bge-m3:latest'),
      m('nomic-embed-text:latest'),
      m('my-embedder', { kind: 'embeddings' }),
    ];
    expect(pickEmbeddingModel(models, '')).toBe('nomic-embed-text:latest');
    expect(pickEmbeddingModel(models, 'bge-m3:latest')).toBe('bge-m3:latest');
    expect(pickEmbeddingModel(models, 'missing')).toBeUndefined();
    expect(pickEmbeddingModel([m('llama3'), m('my-embedder', { kind: 'embeddings' })], '')).toBe(
      'my-embedder',
    );
    expect(pickEmbeddingModel([m('llama3')], '')).toBeUndefined();
  });
});

describe('cachedChunkVectors', () => {
  beforeEach(async () => {
    await getDb().embeddings.clear();
  });

  it('embeds a page once; asking again embeds only the question', async () => {
    const chunks = chunkText(LONG, { size: 200 });
    const embedded: string[][] = [];
    const embed = (texts: string[]) => {
      embedded.push(texts);
      return Promise.resolve(texts.map(mockEmbedding));
    };
    const key = { url: 'https://park.test/guide', contentHash: 'h1', model: 'nomic' };
    const first = await cachedChunkVectors(key, chunks, embed);
    const calls = embedded.length;
    expect(calls).toBeGreaterThan(0);
    const second = await cachedChunkVectors(key, chunks, embed);
    expect(embedded.length).toBe(calls);
    expect(second.map((v) => Array.from(v))).toEqual(
      first.map((v) => Array.from(Float32Array.from(v))),
    );

    // The full flow: a second fit makes one embed call, for the question.
    const a = page();
    const flow: string[][] = [];
    const run = () =>
      fitByRetrieval(a, Math.floor(a.tokens / 4), 'parking fee', {
        model: 'nomic',
        embedChunks: (cs) =>
          cachedChunkVectors({ ...key, contentHash: 'h2' }, cs, (t) => {
            flow.push(t);
            return Promise.resolve(t.map(mockEmbedding));
          }),
        embedQuery: (q) => {
          flow.push([q]);
          return Promise.resolve(mockEmbedding(q));
        },
      });
    await run();
    const afterFirst = flow.length;
    await run();
    expect(flow.slice(afterFirst)).toEqual([['parking fee']]);
  });

  it('replaces vectors of older content for the same page and model', async () => {
    const chunks = chunkText(LONG, { size: 200 });
    const embed = (t: string[]) => Promise.resolve(t.map(mockEmbedding));
    await cachedChunkVectors({ url: 'u', contentHash: 'old', model: 'm' }, chunks, embed);
    await cachedChunkVectors({ url: 'u', contentHash: 'new', model: 'm' }, chunks, embed);
    const rows = await getDb().embeddings.where('url').equals('u').toArray();
    expect(new Set(rows.map((r) => r.contentHash))).toEqual(new Set(['new']));
  });
});
