import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../fixtures/streams');

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(DIR, name)));
}

/** A byte stream delivering `bytes` cut at the given offsets. */
export function streamOf(bytes: Uint8Array, cuts: number[] = []): ReadableStream<Uint8Array> {
  const points = [
    ...new Set([0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length]),
  ].sort((a, b) => a - b);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= points.length - 1) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(points[i], points[i + 1]));
      i++;
    },
  });
}

/** Deterministic pseudo-random cut points (mulberry32). */
export function randomCuts(length: number, count: number, seed: number): number[] {
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => Math.floor(rand() * length));
}

/** A Response with a streamed body, as fetch would return. */
export function streamResponse(
  bytes: Uint8Array,
  init: ResponseInit & { cuts?: number[] } = {},
): Response {
  const { cuts, ...rest } = init;
  return new Response(streamOf(bytes, cuts), { status: 200, ...rest });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
