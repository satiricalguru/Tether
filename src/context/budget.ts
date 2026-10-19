import { estimateTokens } from './tokens';

/**
 * Splitting the context window between attachments. Truncation happens at
 * paragraph boundaries and is always visible to the model and the user.
 */

export const TRUNCATION_MARK = (kept: number, total: number) =>
  `\n\n[truncated: kept about ${kept} of ${total} tokens]`;

/** Keep whole paragraphs from the start until `maxTokens`. */
export function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; tokens: number; truncated: boolean } {
  const total = estimateTokens(text);
  if (total <= maxTokens) return { text, tokens: total, truncated: false };
  const budget = Math.max(0, maxTokens - 16);
  const paras = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;
  for (const p of paras) {
    const t = estimateTokens(p) + 1;
    if (used + t > budget) {
      // Fill the remainder with part of this paragraph, cut at a word.
      const room = budget - used;
      if (room > 32) {
        const ratio = room / t;
        const slice = p.slice(0, Math.floor(p.length * ratio));
        kept.push(slice.replace(/\s+\S*$/, '…'));
        used += estimateTokens(slice);
      }
      break;
    }
    kept.push(p);
    used += t;
  }
  return {
    text: kept.join('\n\n') + TRUNCATION_MARK(used, total),
    tokens: used + 16,
    truncated: true,
  };
}

export interface BudgetItem {
  id: string;
  tokens: number;
}

/**
 * Share `available` tokens between items: small items get what they need,
 * the rest is split evenly among the large ones (water-filling).
 */
export function allocate(items: BudgetItem[], available: number): Map<string, number> {
  const out = new Map<string, number>();
  let remaining = Math.max(0, available);
  let pending = [...items].sort((a, b) => a.tokens - b.tokens);
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const [first] = pending;
    if (first && first.tokens <= share) {
      out.set(first.id, first.tokens);
      remaining -= first.tokens;
      pending = pending.slice(1);
    } else {
      for (const p of pending) out.set(p.id, share);
      break;
    }
  }
  return out;
}

export interface WindowBudget {
  window: number;
  reserve: number;
  fixed: number;
  /** Tokens left for attachments. */
  available: number;
}

/** What's left for attachments once the reply, system prompt, history and question are counted. */
export function windowBudget(opts: {
  window: number;
  maxTokens: number;
  fixedTokens: number;
}): WindowBudget {
  // Never let the reply reserve eat more than half a small window.
  const reserve = Math.min(opts.maxTokens, Math.floor(opts.window / 2));
  return {
    window: opts.window,
    reserve,
    fixed: opts.fixedTokens,
    available: Math.max(0, opts.window - reserve - opts.fixedTokens),
  };
}
