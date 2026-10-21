import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TetherError } from '@/lib/errors';

/**
 * PDF text extraction with pdf.js. Always from bytes Tether already holds
 * (a local file, or a re-read of the open PDF): pdf.js is never given a URL,
 * so it never touches the network.
 *
 * pdf.js 6 has no eval-based code path, and wasm is disabled below, so it runs
 * under the extension CSP unchanged.
 *
 * Build choice: the *legacy* build. pdf.js 6's modern build relies on
 * `Uint8Array.prototype.toHex`, which Chrome only ships from ~140 and Node
 * 24 lacks, while Tether supports Chrome 120+. The legacy build carries the
 * polyfills and runs in both the extension and Vitest.
 *
 * Worker: in the extension the worker file is emitted by Vite (`?url`) and
 * set as `workerSrc`. Where `Worker` doesn't exist (Vitest/node), workerSrc
 * is left alone and pdf.js falls back to its in-thread "fake worker", which
 * imports the sibling `pdf.worker.mjs` itself.
 */

export interface PdfText {
  pages: number;
  title?: string;
  /** "[Page 1]\n…\n\n[Page 2]\n…" */
  text: string;
  truncated: boolean;
}

export interface ExtractPdfOptions {
  maxChars?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

type PdfJs = typeof PdfJsModule;

let loading: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof Worker !== 'undefined') {
      const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    }
    return pdfjs;
  })();
  return loading;
}

export function hasTextLayer(t: PdfText): boolean {
  return t.text.replace(/\[Page \d+\]/g, '').trim().length > 0;
}

interface TextItemLike {
  str: string;
  hasEOL: boolean;
  transform: number[];
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

/** Rebuild lines from positioned text items: break on hasEOL or a baseline change. */
export function itemsToText(items: unknown[]): string {
  let out = '';
  let lastY: number | undefined;
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const y = item.transform[5];
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 1 && !out.endsWith('\n')) {
      out += '\n';
    }
    out += item.str;
    if (item.hasEOL) out += '\n';
    lastY = y;
  }
  return out
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

export { isPdfUrl, pdfSourceUrl } from './pdf-url';

export async function extractPdfText(
  data: ArrayBuffer | Uint8Array,
  opts: ExtractPdfOptions = {},
): Promise<PdfText> {
  const { maxChars = 400_000, maxPages = 500, signal } = opts;
  if (signal?.aborted) throw abortError(signal);
  const pdfjs = await loadPdfJs();
  // pdf.js transfers (detaches) the buffer it is given; hand it a copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));

  const task = pdfjs.getDocument({
    data: bytes,
    // pdf.js 6 removed its eval path (and the isEvalSupported option), so the
    // extension CSP's script-src 'self' needs no relaxation.
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  try {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await task.promise;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'PasswordException') {
        throw new TetherError('E_PDF_PASSWORD', 'This PDF is password-protected', { cause: err });
      }
      throw new TetherError('E_PDF_INVALID', 'This file is not a readable PDF', { cause: err });
    }

    let title: string | undefined;
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof t === 'string' && t.trim()) title = t.trim();
    } catch {
      // Metadata is optional.
    }

    const parts: string[] = [];
    let length = 0;
    let truncated = doc.numPages > maxPages;
    const last = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= last; n++) {
      if (signal?.aborted) throw abortError(signal);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      page.cleanup();
      const block = `[Page ${n}]\n${itemsToText(content.items)}`;
      if (length + block.length > maxChars) {
        const room = maxChars - length;
        if (room > 0) parts.push(block.slice(0, room));
        truncated = true;
        break;
      }
      parts.push(block);
      length += block.length + 2;
    }

    const text = parts.join('\n\n');
    const result: PdfText = {
      pages: doc.numPages,
      // A document with no text at all reads as empty, not as bare page markers.
      text: text.replace(/\[Page \d+\]/g, '').trim() ? text : '',
      truncated,
    };
    if (title) result.title = title;
    return result;
  } finally {
    await task.destroy();
  }
}
