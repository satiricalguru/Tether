import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/context/tokens';
import { chunkText } from '@/rag/chunk';

const para = (n: number, word = 'alpha') =>
  Array.from({ length: n }, (_, i) => `${word}${i} is a sentence about ${word}.`).join(' ');

describe('chunkText', () => {
  it('keeps chunks near the target size', () => {
    const text = Array.from({ length: 40 }, (_, i) => para(8, `w${i}x`)).join('\n\n');
    const chunks = chunkText(text, { size: 200 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(200 * 1.25);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('overlaps consecutive chunks of one section by about 15%', () => {
    // One section, unique sentences, so any repeat is overlap.
    const text = Array.from({ length: 12 }, (_, p) =>
      Array.from({ length: 6 }, (_, i) => `Sentence ${p}-${i} talks about rivers and lakes.`).join(
        ' ',
      ),
    ).join('\n\n');
    const [a, b] = chunkText(text, { size: 200, overlap: 0.15 });
    expect(a && b).toBeTruthy();
    const sentences = (t: string) => t.split(/(?<=\.)\s+/).map((x) => x.trim());
    const inA = new Set(sentences(a!.text));
    const repeated = sentences(b!.text).filter((x) => inA.has(x));
    expect(repeated.length).toBeGreaterThan(0);
    // The repeated part is the start of b and the end of a.
    expect(sentences(b!.text).slice(0, repeated.length)).toEqual(repeated);
    expect(sentences(a!.text).slice(-repeated.length)).toEqual(repeated);
    expect(estimateTokens(repeated.join(' '))).toBeLessThanOrEqual(200 * 0.15);
  });

  it('starts a chunk at a heading and prefixes the heading path', () => {
    const text = [
      '# Guide',
      para(30, 'intro'),
      '## Pricing',
      para(30, 'price'),
      '### Plans',
      para(10, 'plan'),
    ].join('\n\n');
    const chunks = chunkText(text, { size: 400 });
    const pricing = chunks.find((c) => c.text.includes('price0'));
    expect(pricing?.text.startsWith('Guide › Pricing\n\n')).toBe(true);
    expect(pricing?.text).not.toContain('intro0');
    expect(chunks.some((c) => c.headings.join(' › ') === 'Guide › Pricing › Plans')).toBe(true);
  });

  it('merges tiny sections instead of making tiny chunks', () => {
    const text = ['## A', 'Short a.', '## B', 'Short b.', '## C', 'Short c.'].join('\n\n');
    const chunks = chunkText(text, { size: 400 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('Short c.');
  });

  it('splits a long paragraph at sentences, and a run-on sentence at words', () => {
    const long = para(80, 'beta');
    const chunks = chunkText(long, { size: 150 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.trim()).toMatch(/\.$/);
    const runOn = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const parts = chunkText(runOn, { size: 150 });
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.tokens).toBeLessThanOrEqual(150 * 1.25);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
  });
});
