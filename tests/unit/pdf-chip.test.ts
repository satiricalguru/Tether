// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadPdfChip, useContextDraft } from '@/chat/context-store';

const PDF = readFileSync(resolve(import.meta.dirname, '../fixtures/pdfs/two-pages.pdf'));
const URL_ = 'https://papers.example.org/a/paper.pdf?dl=0';

function tabAt(url: string) {
  Object.assign(fakeBrowser.tabs, {
    query: () => Promise.resolve([{ id: 3, url, title: 'paper.pdf', active: true, windowId: 1 }]),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useContextDraft.getState().clear();
});

describe('This PDF', () => {
  it('fetches exactly the open document once permitted, and extracts its pages', async () => {
    tabAt(URL_);
    Object.assign(fakeBrowser.permissions, { contains: () => Promise.resolve(true) });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(PDF)),
    );
    vi.stubGlobal('fetch', fetchMock);
    await loadPdfChip();
    const chip = useContextDraft.getState().chips.pdf;
    expect(chip?.status).toBe('ready');
    expect(chip?.attachments[0]).toMatchObject({ kind: 'pdf', url: URL_ });
    expect(chip?.attachments[0]?.text).toContain('[Page 2]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URL_);
  });

  it('asks for the origin instead of fetching when not permitted', async () => {
    tabAt(URL_);
    Object.assign(fakeBrowser.permissions, { contains: () => Promise.resolve(false) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await loadPdfChip();
    expect(useContextDraft.getState().chips.pdf).toMatchObject({
      status: 'error',
      error: { code: 'E_NO_ACCESS', origin: 'https://papers.example.org/*' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses local files (use Attach PDF)', async () => {
    tabAt('file:///Users/me/paper.pdf');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await loadPdfChip();
    expect(useContextDraft.getState().chips.pdf).toMatchObject({
      status: 'error',
      error: { code: 'E_PDF_URL' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unwraps Chrome’s PDF viewer URL to the document', async () => {
    tabAt(
      `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=${encodeURIComponent(URL_)}`,
    );
    Object.assign(fakeBrowser.permissions, { contains: () => Promise.resolve(true) });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(PDF)),
    );
    vi.stubGlobal('fetch', fetchMock);
    await loadPdfChip();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URL_);
  });
});
