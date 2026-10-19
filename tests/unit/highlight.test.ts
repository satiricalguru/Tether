// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { highlight, normalizeLang } from '@/components/markdown/highlight';

const joined = (lines: { content: string }[][]) =>
  lines.map((l) => l.map((t) => t.content).join('')).join('\n');

describe('normalizeLang', () => {
  it('maps aliases to grammars', () => {
    expect(normalizeLang('js')).toBe('javascript');
    expect(normalizeLang('TS')).toBe('typescript');
    expect(normalizeLang('py')).toBe('python');
    for (const a of ['sh', 'shell', 'zsh', 'console', 'bash'])
      expect(normalizeLang(a)).toBe('bash');
    expect(normalizeLang('yml')).toBe('yaml');
    expect(normalizeLang('rs')).toBe('rust');
    expect(normalizeLang('c++')).toBe('cpp');
    expect(normalizeLang('md')).toBe('markdown');
    expect(normalizeLang('xml')).toBe('xml');
    expect(normalizeLang('dockerfile')).toBe('dockerfile');
    expect(normalizeLang('ts {1,3}')).toBe('typescript');
  });

  it('rejects unknown or empty', () => {
    expect(normalizeLang('brainfuck')).toBeUndefined();
    expect(normalizeLang('')).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
  });
});

describe('highlight (JavaScript regex engine, no wasm)', () => {
  it.each([
    ['ts', 'const x: number = 42;\nexport function f(a: string) { return a; }'],
    ['python', 'def f(x):\n    return x + 1  # comment'],
    ['bash', 'echo "hi" && ls -la | grep foo'],
  ])('highlights %s with distinct light and dark colors', async (lang, code) => {
    const lines = await highlight(code, lang);
    expect(lines).not.toBeNull();
    expect(joined(lines!)).toBe(code);
    const tokens = lines!.flat();
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens.every((t) => t.light && t.dark)).toBe(true);
    expect(tokens.some((t) => t.light.toLowerCase() !== t.dark.toLowerCase())).toBe(true);
    expect(new Set(tokens.map((t) => t.light)).size).toBeGreaterThan(1);
  });

  it('returns null for unsupported languages', async () => {
    await expect(highlight('+++[>]', 'brainfuck')).resolves.toBeNull();
    await expect(highlight('x', undefined)).resolves.toBeNull();
  });

  it('survives huge and garbage input', async () => {
    const garbage = '"\'`/*{[(<'.repeat(2000) + '\u0000￿\n'.repeat(50);
    const lines = await highlight(garbage, 'typescript');
    expect(lines === null || joined(lines).length > 0).toBe(true);
    const big = 'let a = 1;\n'.repeat(3000);
    const out = await highlight(big, 'js');
    expect(out?.length).toBe(3001);
  });
});
