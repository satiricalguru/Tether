import type { HighlighterCore, LanguageRegistration } from 'shiki/core';

/**
 * Syntax highlighting with shiki's core build and its JavaScript regex
 * engine: no WebAssembly, so the extension CSP stays `script-src 'self'`.
 * Each language grammar is its own lazily imported chunk.
 */

export interface HighlightedToken {
  content: string;
  light: string;
  dark: string;
}

export type HighlightedLine = HighlightedToken[];

interface Grammar {
  default: LanguageRegistration[];
}

const LOADERS: Record<string, () => Promise<Grammar>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  jsonc: 'json',
  json5: 'json',
  htm: 'html',
  svg: 'xml',
  md: 'markdown',
  yml: 'yaml',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  patch: 'diff',
  docker: 'dockerfile',
};

/** Canonical grammar name for a fence info string, or undefined if unsupported. */
export function normalizeLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const key = lang.trim().toLowerCase().split(/[\s{]/)[0] ?? '';
  const name = ALIASES[key] ?? key;
  return name in LOADERS ? name : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighter;
}

function ensureLang(h: HighlighterCore, name: string): Promise<void> {
  let p = loaded.get(name);
  if (!p) {
    const loader = LOADERS[name];
    if (!loader) return Promise.reject(new Error(`no grammar for ${name}`));
    p = loader().then((m) => h.loadLanguage(...m.default));
    loaded.set(name, p);
  }
  return p;
}

/** Highlighted lines with light and dark colors per token, or null to render plain. */
export async function highlight(
  code: string,
  lang: string | undefined,
): Promise<HighlightedLine[] | null> {
  const name = normalizeLang(lang);
  if (!name) return null;
  try {
    const h = await getHighlighter();
    await ensureLang(h, name);
    const lines = h.codeToTokensWithThemes(code, {
      lang: name,
      themes: { light: 'github-light', dark: 'github-dark' },
    });
    return lines.map((line) =>
      line.map((t) => ({
        content: t.content,
        light: t.variants.light?.color ?? '',
        dark: t.variants.dark?.color ?? '',
      })),
    );
  } catch {
    return null;
  }
}
