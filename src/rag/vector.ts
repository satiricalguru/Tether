/** Vector search for retrieval: cosine similarity, top-k and MMR. */

export type Vector = ArrayLike<number>;

export function cosine(a: Vector, b: Vector): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Indices of the `k` vectors most similar to `query`, best first. */
export function topK(query: Vector, vectors: Vector[], k: number): number[] {
  return vectors
    .map((v, i) => ({ i, s: cosine(query, v) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(0, k))
    .map((x) => x.i);
}

/**
 * Maximal marginal relevance: each pick is the vector most similar to the
 * query, minus its similarity to what's already picked. `lambda` 1 is pure
 * relevance; lower values push near-duplicates down. Returns indices in
 * pick order.
 */
export function mmr(query: Vector, vectors: Vector[], k: number, lambda = 0.7): number[] {
  const relevance = vectors.map((v) => cosine(query, v));
  const picked: number[] = [];
  const left = new Set(vectors.map((_, i) => i));
  while (picked.length < k && left.size) {
    let best = -1;
    let bestScore = -Infinity;
    for (const i of left) {
      const vi = vectors[i];
      if (!vi) continue;
      let redundancy = 0;
      for (const j of picked) {
        const vj = vectors[j];
        if (vj) redundancy = Math.max(redundancy, cosine(vi, vj));
      }
      const score = lambda * (relevance[i] ?? 0) - (1 - lambda) * redundancy;
      if (score > bestScore || (score === bestScore && i < best)) {
        best = i;
        bestScore = score;
      }
    }
    if (best < 0) break;
    picked.push(best);
    left.delete(best);
  }
  return picked;
}
