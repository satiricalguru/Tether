/**
 * A small GBNF parser and recognizer for the subset Tether emits, so the
 * generated grammars can be checked without llama.cpp: literals with
 * escapes, character classes (ranges, negation, escapes), rule references,
 * groups, alternation, and the ? * + {m} {m,} {m,n} quantifiers.
 *
 * Matching is set-based (all end positions) with memoized rule calls, which
 * keeps the bounded repetitions (`char{0,400}`) cheap.
 */

type Node =
  | { t: 'lit'; cps: number[] }
  | { t: 'cls'; neg: boolean; ranges: [number, number][] }
  | { t: 'ref'; name: string }
  | { t: 'alt'; alts: Node[][] }
  | { t: 'rep'; node: Node; min: number; max: number };

export interface Grammar {
  rules: Map<string, Node>;
  /** Every rule name referenced anywhere. */
  refs: Set<string>;
}

class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly refs: Set<string>,
  ) {}

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  private skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '#') while (this.i < this.src.length && this.peek() !== '\n') this.i++;
      else return;
    }
  }

  private escape(): number {
    // at backslash
    this.i++;
    const c = this.peek();
    this.i++;
    switch (c) {
      case 'n':
        return 10;
      case 'r':
        return 13;
      case 't':
        return 9;
      case 'x':
        return this.hex(2);
      case 'u':
        return this.hex(4);
      case 'U':
        return this.hex(8);
      default:
        return c.codePointAt(0) ?? 0;
    }
  }

  private hex(n: number): number {
    const h = this.src.slice(this.i, this.i + n);
    if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== n) throw new Error(`bad hex escape at ${this.i}`);
    this.i += n;
    return parseInt(h, 16);
  }

  private char(): number {
    if (this.peek() === '\\') return this.escape();
    const cp = this.src.codePointAt(this.i) ?? 0;
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }

  parseAlternatives(stopAtParen: boolean): Node {
    const alts: Node[][] = [[]];
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (c === '' || (stopAtParen && c === ')')) break;
      if (!stopAtParen && /[a-z0-9-]/.test(c) && this.atRuleStart()) break;
      if (c === '|') {
        this.i++;
        alts.push([]);
        continue;
      }
      const atom = this.atom();
      alts[alts.length - 1]!.push(this.quantifier(atom));
    }
    return { t: 'alt', alts };
  }

  /** Is the upcoming identifier the start of a new `name ::=` rule? */
  private atRuleStart(): boolean {
    return /^[a-zA-Z0-9-]+\s*::=/.test(this.src.slice(this.i));
  }

  private atom(): Node {
    const c = this.peek();
    if (c === '"') {
      this.i++;
      const cps: number[] = [];
      while (this.peek() !== '"') {
        if (this.peek() === '') throw new Error('unterminated literal');
        cps.push(this.char());
      }
      this.i++;
      return { t: 'lit', cps };
    }
    if (c === '[') {
      this.i++;
      let neg = false;
      if (this.peek() === '^') {
        neg = true;
        this.i++;
      }
      const ranges: [number, number][] = [];
      while (this.peek() !== ']') {
        if (this.peek() === '') throw new Error('unterminated class');
        const lo = this.char();
        if (this.peek() === '-' && this.src[this.i + 1] !== ']') {
          this.i++;
          ranges.push([lo, this.char()]);
        } else ranges.push([lo, lo]);
      }
      this.i++;
      return { t: 'cls', neg, ranges };
    }
    if (c === '(') {
      this.i++;
      const inner = this.parseAlternatives(true);
      if (this.peek() !== ')') throw new Error('unbalanced (');
      this.i++;
      return inner;
    }
    const m = /^[a-zA-Z0-9-]+/.exec(this.src.slice(this.i));
    if (!m) throw new Error(`unexpected "${c}" at ${this.i}`);
    this.i += m[0].length;
    this.refs.add(m[0]);
    return { t: 'ref', name: m[0] };
  }

  private quantifier(node: Node): Node {
    const c = this.peek();
    if (c === '?') {
      this.i++;
      return { t: 'rep', node, min: 0, max: 1 };
    }
    if (c === '*') {
      this.i++;
      return { t: 'rep', node, min: 0, max: Infinity };
    }
    if (c === '+') {
      this.i++;
      return { t: 'rep', node, min: 1, max: Infinity };
    }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) throw new Error(`bad repetition at ${this.i}`);
      this.i += m[0].length;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
      return { t: 'rep', node, min, max };
    }
    return node;
  }
}

export function parseGbnf(text: string): Grammar {
  const rules = new Map<string, Node>();
  const refs = new Set<string>();
  const re = /^([^\s#][^\s]*)\s*::=/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, idx) => {
    const name = h[1] ?? '';
    if (rules.has(name)) throw new Error(`duplicate rule ${name}`);
    const start = h.index + h[0].length;
    const end = heads[idx + 1]?.index ?? text.length;
    const parser = new Parser(text.slice(start, end), refs);
    rules.set(name, parser.parseAlternatives(false));
  });
  return { rules, refs };
}

export function accepts(grammar: Grammar, input: string, start = 'root'): boolean {
  // Code points (not graphemes) are exactly what GBNF character classes match.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code-point split is intended
  const cps = [...input].map((c) => c.codePointAt(0) ?? 0);
  const memo = new Map<string, number[]>();
  const active = new Set<string>();

  const uniq = (xs: number[]) => [...new Set(xs)];

  const matchSeq = (seq: Node[], pos: number): number[] => {
    let cur = [pos];
    for (const n of seq) {
      const next: number[] = [];
      for (const p of cur) next.push(...match(n, p));
      cur = uniq(next);
      if (cur.length === 0) return [];
    }
    return cur;
  };

  const match = (node: Node, pos: number): number[] => {
    switch (node.t) {
      case 'lit': {
        for (let k = 0; k < node.cps.length; k++) if (cps[pos + k] !== node.cps[k]) return [];
        return [pos + node.cps.length];
      }
      case 'cls': {
        const cp = cps[pos];
        if (cp === undefined) return [];
        const inside = node.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
        return inside !== node.neg ? [pos + 1] : [];
      }
      case 'ref': {
        const key = `${node.name}@${pos}`;
        const hit = memo.get(key);
        if (hit) return hit;
        if (active.has(key)) return [];
        const rule = grammar.rules.get(node.name);
        if (!rule) throw new Error(`undefined rule ${node.name}`);
        active.add(key);
        const out = match(rule, pos);
        active.delete(key);
        memo.set(key, out);
        return out;
      }
      case 'alt':
        return uniq(node.alts.flatMap((seq) => matchSeq(seq, pos)));
      case 'rep': {
        const results: number[] = node.min === 0 ? [pos] : [];
        let current = [pos];
        for (let k = 1; k <= node.max && current.length; k++) {
          const next: number[] = [];
          for (const p of current) for (const e of match(node.node, p)) if (e > p) next.push(e);
          current = uniq(next);
          if (k >= node.min) results.push(...current);
        }
        return uniq(results);
      }
    }
  };

  return match({ t: 'ref', name: start }, 0).includes(cps.length);
}
