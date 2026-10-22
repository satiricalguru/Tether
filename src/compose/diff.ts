/**
 * Word-level diff for the inline compose preview. Tokens are runs of
 * non-space characters and runs of whitespace, so joining the parts of
 * either side gives back that side exactly.
 */

export interface DiffPart {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many token pairs the LCS table gets expensive; fall back to one replace. */
const MAX_CELLS = 2_000_000;

function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

function push(out: DiffPart[], op: DiffPart['op'], text: string): void {
  if (!text) return;
  const last = out.at(-1);
  if (last?.op === op) last.text += text;
  else out.push({ op, text });
}

/** Parts that turn `before` into `after`: deletions before insertions at each change. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const out: DiffPart[] = [];
  // Common prefix and suffix first: most edits touch a small part of the text.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  push(out, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    push(out, 'del', midA.join(''));
    push(out, 'add', midB.join(''));
  } else {
    // LCS lengths of midA[i..] and midB[j..], row-major in one flat array.
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    let del = '';
    let add = '';
    const flush = () => {
      push(out, 'del', del);
      push(out, 'add', add);
      del = '';
      add = '';
    };
    while (i < n && j < m) {
      const x = midA[i] ?? '';
      if (x === midB[j]) {
        flush();
        push(out, 'same', x);
        i++;
        j++;
      } else if (at(i + 1, j) >= at(i, j + 1)) {
        del += x;
        i++;
      } else {
        add += midB[j] ?? '';
        j++;
      }
    }
    del += midA.slice(i).join('');
    add += midB.slice(j).join('');
    flush();
  }
  push(out, 'same', a.slice(endA).join(''));
  return out;
}

/** Counts for a one-line summary ("3 words removed, 5 added"). */
export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.op === 'add') added += words(p.text);
    else if (p.op === 'del') removed += words(p.text);
  }
  return { added, removed };
}
