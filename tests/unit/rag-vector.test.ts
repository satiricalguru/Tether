import { describe, expect, it } from 'vitest';
import { cosine, mmr, topK } from '@/rag/vector';

describe('vector search', () => {
  it('cosine: 1 for the same direction, 0 for orthogonal, 0 for a zero vector', () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine(Float32Array.from([1, 1]), [1, 1])).toBeCloseTo(1, 6);
  });

  it('topK returns the most similar indices, best first', () => {
    const vs = [
      [0, 1],
      [1, 0.1],
      [1, 0],
      [-1, 0],
    ];
    expect(topK([1, 0], vs, 2)).toEqual([2, 1]);
    expect(topK([1, 0], vs, 0)).toEqual([]);
  });

  it('mmr skips near-duplicates in favour of different relevant vectors', () => {
    const vs = [
      [1, 0, 0],
      [0.99, 0.01, 0], // near-duplicate of 0
      [0.7, 0, 0.7], // relevant and different
    ];
    expect(topK([1, 0, 0.2], vs, 2)).toEqual([0, 1]);
    expect(mmr([1, 0, 0.2], vs, 2, 0.5)).toEqual([0, 2]);
    // lambda 1 is plain relevance
    expect(mmr([1, 0, 0.2], vs, 2, 1)).toEqual([0, 1]);
    expect(mmr([1, 0, 0], vs, 10)).toHaveLength(3);
  });
});
