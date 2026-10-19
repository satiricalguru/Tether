import type { ChatChunk } from './types';

/**
 * Splits inline reasoning (`<think>…</think>` / `<thinking>…</thinking>`) out
 * of a streamed text channel. Servers that don't separate reasoning
 * themselves (or models whose template puts the opening tag in the prompt)
 * deliver it inline; the UI hides it by default and it must never be fed
 * back into the next turn.
 *
 * Rules, chosen so ordinary answers are never mangled:
 *  - An opening tag counts only before any visible text has been emitted.
 *  - A closing tag with no opening tag, before any reasoning was seen, means
 *    the model started inside its reasoning: everything so far is
 *    reclassified (a `reclassify-reasoning` chunk).
 *  - After the first reasoning block ends, the rest is plain text.
 */

const OPEN_TAGS = ['<think>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thinking>'];

type Out = Extract<ChatChunk, { type: 'text' | 'reasoning' | 'reclassify-reasoning' }>;

function findTag(haystack: string, tags: string[]): { index: number; length: number } | null {
  const lower = haystack.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const tag of tags) {
    const index = lower.indexOf(tag);
    if (index !== -1 && (best === null || index < best.index)) best = { index, length: tag.length };
  }
  return best;
}

/** Length of the longest suffix of `s` that is a proper prefix of some tag. */
function partialTagSuffix(s: string, tags: string[]): number {
  const lower = s.toLowerCase();
  let longest = 0;
  for (const tag of tags) {
    for (let n = Math.min(tag.length - 1, lower.length); n > longest; n--) {
      if (tag.startsWith(lower.slice(lower.length - n))) {
        longest = n;
        break;
      }
    }
  }
  return longest;
}

export class ThinkSplitter {
  private mode: 'text' | 'reasoning' = 'text';
  private pending = '';
  private visibleText = false;
  private reasoningSeen = false;
  private trimLeading = false;

  push(delta: string): Out[] {
    this.pending += delta;
    const out: Out[] = [];
    this.drain(out, false);
    return out;
  }

  flush(): Out[] {
    const out: Out[] = [];
    this.drain(out, true);
    if (this.pending) {
      this.emit(out, this.mode, this.pending);
      this.pending = '';
    }
    return out;
  }

  private emit(out: Out[], kind: 'text' | 'reasoning', raw: string) {
    let text = raw;
    if (this.trimLeading) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.trimLeading = false;
    }
    if (!text) return;
    if (kind === 'text') {
      if (!this.visibleText && !text.trim()) return; // hold back leading whitespace
      if (!this.visibleText) text = text.replace(/^\s+/, '');
      this.visibleText = true;
    } else {
      this.reasoningSeen = true;
    }
    const last = out.at(-1);
    if (last?.type === kind) last.text += text;
    else out.push({ type: kind, text });
  }

  private drain(out: Out[], final: boolean) {
    for (;;) {
      if (this.mode === 'reasoning') {
        const close = findTag(this.pending, CLOSE_TAGS);
        if (close) {
          this.emit(out, 'reasoning', this.pending.slice(0, close.index));
          this.pending = this.pending.slice(close.index + close.length);
          this.mode = 'text';
          this.trimLeading = true;
          continue;
        }
        const hold = final ? 0 : partialTagSuffix(this.pending, CLOSE_TAGS);
        this.emit(out, 'reasoning', this.pending.slice(0, this.pending.length - hold));
        this.pending = this.pending.slice(this.pending.length - hold);
        return;
      }

      // Text mode, once reasoning is over: no more tag handling.
      if (this.reasoningSeen) {
        this.emit(out, 'text', this.pending);
        this.pending = '';
        return;
      }

      if (!this.visibleText) {
        const trimmed = this.pending.replace(/^\s+/, '');
        const open = OPEN_TAGS.find((t) => trimmed.toLowerCase().startsWith(t));
        if (open) {
          this.pending = trimmed.slice(open.length);
          this.mode = 'reasoning';
          this.reasoningSeen = true;
          this.trimLeading = true;
          continue;
        }
        if (!final && OPEN_TAGS.some((t) => t.startsWith(trimmed.toLowerCase()))) {
          return; // could still become an opening tag
        }
      }

      const close = findTag(this.pending, CLOSE_TAGS);
      if (close) {
        // Untagged reasoning: everything before the close was thinking.
        const before = this.pending.slice(0, close.index);
        if (this.visibleText) {
          this.emit(out, 'text', before);
          out.push({ type: 'reclassify-reasoning' });
        } else {
          this.emit(out, 'reasoning', before);
        }
        this.reasoningSeen = true;
        this.visibleText = false;
        this.pending = this.pending.slice(close.index + close.length);
        this.trimLeading = true;
        continue;
      }

      const hold = final ? 0 : partialTagSuffix(this.pending, CLOSE_TAGS);
      this.emit(out, 'text', this.pending.slice(0, this.pending.length - hold));
      this.pending = this.pending.slice(this.pending.length - hold);
      return;
    }
  }
}
