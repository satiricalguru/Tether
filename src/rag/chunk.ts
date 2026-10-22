import { estimateTokens } from '@/context/tokens';

/**
 * Heading-aware chunking for retrieval. Page text from the extractor (and
 * PDF text) marks headings Markdown-style ("## Pricing"); paragraphs are
 * separated by blank lines.
 *
 * - Chunks are about `size` tokens. A chunk doesn't run across a heading
 *   once it holds a quarter of `size` (tiny sections are merged instead of
 *   becoming tiny chunks).
 * - Each chunk starts with its heading path ("Pricing › Plans") so it reads
 *   on its own.
 * - Within a section, consecutive chunks overlap by `overlap` of `size`.
 * - Paragraphs stay whole when they fit; longer ones split at sentences,
 *   and a sentence longer than a chunk splits at words.
 */

export interface Chunk {
  index: number;
  /** Heading path, then the body: what gets embedded and sent. */
  text: string;
  headings: string[];
  tokens: number;
}

export interface ChunkOptions {
  size?: number;
  /** Fraction of `size` repeated at the start of the next chunk in the same section. */
  overlap?: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface Block {
  text: string;
  tokens: number;
  headings: string[];
  /** First block after a heading: a good place to start a chunk. */
  sectionStart: boolean;
}

function splitLong(text: string, size: number): string[] {
  if (estimateTokens(text) <= size) return [text];
  const sentences = text.split(/(?<=[.!?…])\s+(?=\S)/);
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const s of sentences) {
    if (estimateTokens(s) > size) {
      push();
      // A run-on "sentence": cut at words.
      const words = s.split(/\s+/);
      let part = '';
      for (const w of words) {
        const next = part ? `${part} ${w}` : w;
        if (part && estimateTokens(next) > size) {
          out.push(part);
          part = w;
        } else part = next;
      }
      if (part) out.push(part);
      continue;
    }
    const next = cur ? `${cur} ${s}` : s;
    if (cur && estimateTokens(next) > size) {
      push();
      cur = s;
    } else cur = next;
  }
  push();
  return out;
}

function blocks(text: string, size: number): Block[] {
  const out: Block[] = [];
  const path: { level: number; title: string }[] = [];
  let sectionStart = true;
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    const lines = para.split('\n');
    const h = HEADING.exec(lines[0] ?? '');
    if (h?.[1] && h[2]) {
      const level = h[1].length;
      while (path.length && (path.at(-1)?.level ?? 0) >= level) path.pop();
      path.push({ level, title: h[2] });
      sectionStart = true;
      const rest = lines.slice(1).join('\n').trim();
      if (!rest) continue;
      lines.splice(0, lines.length, rest);
    }
    const headings = path.map((p) => p.title);
    for (const piece of splitLong(lines.join('\n'), size)) {
      out.push({ text: piece, tokens: estimateTokens(piece), headings, sectionStart });
      sectionStart = false;
    }
  }
  return out;
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const size = opts.size ?? 800;
  const overlapTokens = Math.round(size * (opts.overlap ?? 0.15));
  const chunks: Chunk[] = [];
  let body: Block[] = [];
  let used = 0;

  const emit = () => {
    if (!body.length) return;
    const headings = body[0]?.headings ?? [];
    const head = headings.length ? `${headings.join(' › ')}\n\n` : '';
    const textOut = head + body.map((b) => b.text).join('\n\n');
    chunks.push({ index: chunks.length, text: textOut, headings, tokens: estimateTokens(textOut) });
  };

  for (const b of blocks(text, size)) {
    const last = body.at(-1);
    const sameSection = !!last && last.headings.join('\n') === b.headings.join('\n');
    if (body.length && b.sectionStart && used >= size / 4) {
      // New section and the chunk has substance: start fresh, no overlap.
      emit();
      body = [];
      used = 0;
    } else if (body.length && used + b.tokens > size) {
      emit();
      // Carry the tail of this chunk into the next when it's the same section.
      const carry: Block[] = [];
      let carried = 0;
      if (sameSection) {
        for (let i = body.length - 1; i >= 0; i--) {
          const prev = body[i];
          if (!prev) break;
          if (carried + prev.tokens > overlapTokens) {
            // Part of a paragraph: its last sentences up to the overlap.
            const sentences = prev.text.split(/(?<=[.!?…])\s+(?=\S)/);
            const tail: string[] = [];
            for (let j = sentences.length - 1; j >= 0; j--) {
              const s = sentences[j] ?? '';
              const t = estimateTokens(s);
              if (carried + t > overlapTokens) break;
              tail.unshift(s);
              carried += t;
            }
            if (tail.length) {
              const t = tail.join(' ');
              carry.unshift({ ...prev, text: t, tokens: estimateTokens(t), sectionStart: false });
            }
            break;
          }
          carry.unshift(prev);
          carried += prev.tokens;
        }
      }
      body = carry;
      used = carried;
    }
    body.push(b);
    used += b.tokens;
  }
  emit();
  return chunks;
}
