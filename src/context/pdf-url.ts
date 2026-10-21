/**
 * PDF URL helpers, kept apart from pdf.ts so callers that only need to know
 * "is this a PDF?" (the background worker) don't pull pdf.js into their bundle.
 */

export const CHROME_PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

function viewerTarget(url: URL): string | undefined {
  return url.searchParams.get('src') ?? url.searchParams.get('file') ?? undefined;
}

/** Unwrap Chrome's built-in PDF viewer URL to the document URL; identity otherwise. */
export function pdfSourceUrl(url: string): string {
  if (!url.startsWith(CHROME_PDF_VIEWER)) return url;
  try {
    return viewerTarget(new URL(url)) ?? url;
  } catch {
    return url;
  }
}

/** Does this tab URL show a PDF? (path ends in .pdf, or Chrome's viewer pointing at one) */
export function isPdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (url.startsWith(CHROME_PDF_VIEWER)) {
    const target = viewerTarget(parsed);
    return target !== undefined && target !== url && isPdfUrl(target);
  }
  return /\.pdf$/i.test(parsed.pathname);
}
