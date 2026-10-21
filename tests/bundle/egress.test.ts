import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static half of the zero-egress guarantee (the runtime half is the origin
 * allowlist in src/providers/http.ts). Every URL literal in the shipped
 * bundle must be a local model endpoint or a string that is never fetched.
 * Adding a new host means adding it here, with a reason, in review.
 */

const OUT = resolve(import.meta.dirname, '../../.output/chrome-mv3');

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d*)?(\/|$)/;

/**
 * Non-local URL strings that appear in the bundle but are never requested.
 * `file` scopes an entry to specific output files, so the same string
 * appearing anywhere else still fails.
 */
const PDFJS = /^(chunks\/pdf-[\w-]+\.js|assets\/pdf\.worker\.min-[\w-]+\.mjs)$/;

const NEVER_FETCHED: { pattern: RegExp; reason: string; file?: RegExp }[] = [
  {
    pattern:
      /^(http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0|https:\/\/github\.com\/zloirock\/core-js(\/blob\/v[\d.]+\/LICENSE)?)$/,
    reason: 'pdf.js and its core-js polyfills: license links in comments',
    file: PDFJS,
  },
  {
    pattern: /^(https:\/\/(a|x|a\/c%20d\?a=1&c=3|a@b|тест|a#б|foo\.bar)|http:\/\/example\.com)$/,
    reason:
      'core-js feature probes: `new URL(...)` parsed locally to test URL support, never fetched',
    file: PDFJS,
  },
  {
    pattern: /^http:\/\/(www\.xfa\.org\/schema\/|ns\.adobe\.com\/(xdp|xfdf|xmpmeta)\/)/,
    reason: 'XFA / XMP namespace URIs pdf.js compares against document metadata',
    file: PDFJS,
  },
  {
    pattern: /^http:\/\/www\.w3\.org\//,
    reason: 'XML/SVG/MathML namespace URIs used by React DOM',
  },
  {
    pattern: /^https:\/\/react\.dev\/errors\//,
    reason: 'React minified-error decoder link in messages',
  },
  { pattern: /^https:\/\/tailwindcss\.com$/, reason: 'license banner comment in the CSS' },
  {
    pattern: /^http:\/\/$/,
    reason: 'marked prefixes GFM "www." autolinks with a scheme; rendering a link never fetches it',
  },
  {
    pattern: /^https:\/\/github\.com\/markedjs\/marked\.$/,
    reason: 'marked\'s "please report this" error message',
  },
  {
    pattern: /^(https:\/\/tinyurl\.com\/y2uuvskb|http:\/\/bit\.ly\/2kdckMn)$/,
    reason: 'Dexie error-message help links',
  },
  {
    pattern: /^http:\/\/\$\{\w+\}$/,
    reason:
      'normalizeBaseUrl adds a default scheme to a user-entered URL; where it goes is decided by the runtime allowlist',
  },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`)\\<>]*/g;

describe('built bundle', () => {
  it('exists (run `pnpm build` first)', () => {
    expect(existsSync(join(OUT, 'manifest.json'))).toBe(true);
  });

  const textFiles = existsSync(OUT)
    ? files(OUT).filter((f) => /\.(js|mjs|html|css|json)$/.test(f))
    : [];

  it('contains no URL to a host other than local endpoints or never-fetched strings', () => {
    const offenders: string[] = [];
    for (const file of textFiles) {
      for (const url of readFileSync(file, 'utf8').match(URL_RE) ?? []) {
        if (LOCAL.test(url)) continue;
        const rel = relative(OUT, file);
        if (NEVER_FETCHED.some((n) => n.pattern.test(url) && (!n.file || n.file.test(rel))))
          continue;
        offenders.push(`${relative(OUT, file)}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads no remote scripts or styles', () => {
    for (const file of textFiles.filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(file, 'utf8');
      expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']?(https?:)?\/\//i);
    }
  });

  it('ships a CSP that forbids remote code', () => {
    const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as {
      content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self'; object-src 'self';",
    );
  });

  it('every allow-listed exception is still needed', () => {
    const all = textFiles.flatMap((f) => readFileSync(f, 'utf8').match(URL_RE) ?? []);
    for (const n of NEVER_FETCHED) {
      expect(
        all.some((u) => n.pattern.test(u)),
        `${n.pattern} (${n.reason})`,
      ).toBe(true);
    }
  });
});
