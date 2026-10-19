/**
 * Token estimate without a tokenizer. BPE vocabularies (Llama, Qwen, Gemma,
 * Mistral) average ~0.75 words/token for English prose, split punctuation
 * and digit runs, and spend about one token per CJK character. This tracks
 * real counts within roughly ±15% on mixed text, which is plenty for
 * budgeting with headroom.
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
const WORD = /[\p{L}\p{M}]+/gu;
const DIGITS = /\p{N}+/gu;
const PUNCT = /[^\p{L}\p{M}\p{N}\s]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, ' ') : text;
  let words = 0;
  for (const w of rest.match(WORD) ?? []) words += Math.max(1, Math.ceil(w.length / 6));
  let digits = 0;
  for (const d of rest.match(DIGITS) ?? []) digits += Math.ceil(d.length / 3);
  const punct = rest.match(PUNCT)?.length ?? 0;
  return Math.ceil(cjk + words * 1.1 + digits + punct * 0.8);
}

/** Per-message framing overhead in chat templates. */
export const MESSAGE_OVERHEAD = 4;
