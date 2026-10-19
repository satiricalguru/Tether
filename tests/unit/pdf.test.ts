// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdfText, hasTextLayer, isPdfUrl, itemsToText, pdfSourceUrl } from '@/context/pdf';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(import.meta.dirname, '../fixtures/pdfs', name)));

describe('extractPdfText', () => {
  it('extracts each page with markers, title and non-ASCII text', async () => {
    const r = await extractPdfText(fixture('two-pages.pdf'));
    expect(r.pages).toBe(2);
    expect(r.title).toBe('Tether fixture document');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(
      [
        '[Page 1]',
        'Tether reads documents locally.',
        'This is an extraordinary sentence about the café.',
        '',
        '[Page 2]',
        'The second page has its own text.',
        'Nothing leaves your machine.',
      ].join('\n'),
    );
    expect(hasTextLayer(r)).toBe(true);
  });

  it('accepts an ArrayBuffer and leaves the caller’s bytes intact', async () => {
    const bytes = fixture('two-pages.pdf');
    const r = await extractPdfText(bytes.buffer.slice(0));
    expect(r.pages).toBe(2);
    // pdf.js detaches what it is given; our copy protects the caller.
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    await expect(extractPdfText(bytes)).resolves.toMatchObject({ pages: 2 });
  });

  it('truncates at maxChars and maxPages', async () => {
    const short = await extractPdfText(fixture('two-pages.pdf'), { maxChars: 60 });
    expect(short.truncated).toBe(true);
    expect(short.text.length).toBeLessThanOrEqual(60);
    expect(short.text.startsWith('[Page 1]')).toBe(true);

    const one = await extractPdfText(fixture('two-pages.pdf'), { maxPages: 1 });
    expect(one.truncated).toBe(true);
    expect(one.text).not.toContain('[Page 2]');
    expect(one.pages).toBe(2);
  });

  it('honours an abort signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('stop', 'AbortError'));
    await expect(
      extractPdfText(fixture('two-pages.pdf'), { signal: ctrl.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports a PDF without a text layer as empty', async () => {
    const r = await extractPdfText(fixture('no-text.pdf'));
    expect(r.pages).toBe(1);
    expect(r.text).toBe('');
    expect(hasTextLayer(r)).toBe(false);
  });

  it('rejects corrupt and password-protected files with clear codes', async () => {
    await expect(extractPdfText(fixture('corrupt.pdf'))).rejects.toMatchObject({
      code: 'E_PDF_INVALID',
    });
    await expect(extractPdfText(fixture('encrypted.pdf'))).rejects.toMatchObject({
      code: 'E_PDF_PASSWORD',
    });
  });
});

describe('itemsToText', () => {
  const item = (str: string, y: number, hasEOL = false) => ({
    str,
    hasEOL,
    transform: [1, 0, 0, 1, 0, y],
  });

  it('breaks lines on baseline changes and EOL flags, joins same-line items', () => {
    expect(
      itemsToText([
        item('Hello', 700),
        item(' world', 700),
        item('Next', 680, true),
        item('Last', 660),
      ]),
    ).toBe('Hello world\nNext\nLast');
  });

  it('dehyphenates only before a lowercase continuation and collapses spaces', () => {
    expect(itemsToText([item('co-', 700, true), item('operate   now', 680)])).toBe('cooperate now');
    expect(itemsToText([item('Jean-', 700, true), item('Paul', 680)])).toBe('Jean-\nPaul');
  });

  it('ignores marked-content items without text', () => {
    expect(itemsToText([{ type: 'beginMarkedContent' }, item('ok', 1)])).toBe('ok');
  });
});

describe('PDF URLs', () => {
  it('recognizes .pdf paths regardless of case, query or hash', () => {
    expect(isPdfUrl('https://example.com/paper.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/PAPER.PDF?download=1#page=3')).toBe(true);
    expect(isPdfUrl('file:///Users/me/report.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/pdf-guide.html')).toBe(false);
    expect(isPdfUrl('https://example.com/?file=a.pdf')).toBe(false);
    expect(isPdfUrl(undefined)).toBe(false);
    expect(isPdfUrl('not a url')).toBe(false);
  });

  it('unwraps Chrome’s PDF viewer URL', () => {
    const viewer =
      'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.com%2Fa.pdf';
    expect(isPdfUrl(viewer)).toBe(true);
    expect(pdfSourceUrl(viewer)).toBe('https://example.com/a.pdf');
    expect(
      isPdfUrl(
        'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.com%2Fpage',
      ),
    ).toBe(false);
    expect(isPdfUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')).toBe(false);
    expect(pdfSourceUrl('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
  });
});
