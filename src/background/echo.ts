import { sleep } from '@/lib/sleep';
import type { StreamHandler } from '@/lib/ports';

/** Split into word-ish tokens that keep their trailing whitespace. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/** Transport check stream: replays the input one token at a time. */
export const echoStream: StreamHandler<'echo'> = async function* (req, { signal }) {
  const tokens = tokenize(req.text);
  const delay = Math.max(0, Math.min(req.delayMs ?? 40, 2_000));
  let index = 0;
  for (const token of tokens) {
    await sleep(delay, signal);
    yield { token, index };
    index += 1;
  }
  return { count: index };
};
