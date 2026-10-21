import { browser } from 'wxt/browser';
import { create } from 'zustand';
import type { Attachment } from '@/context/attachments';
import { toAttachment, toAttachmentFromExtract } from '@/context/build';
import { currentPageTab } from '@/platform/tabs';
import { HttpClient } from '@/providers/http';
import { TetherError } from '@/lib/errors';
import { sendMessage } from '@/lib/messaging';
import type { TabSummary } from '@/lib/protocol';

/**
 * Context drafted for the next message: chips the user switched on, and
 * what each one resolved to. Attachments move onto the user message when it
 * is sent; the chips then reset.
 */

export type ChipKind = 'page' | 'selection' | 'tabs' | 'pdf' | 'file';

export interface ChipState {
  kind: ChipKind;
  status: 'loading' | 'ready' | 'error';
  attachments: Attachment[];
  error?: { message: string; code?: string; origin?: string };
  /** For "All tabs": tabs that couldn't be read. */
  skipped?: { title: string; reason: string }[];
}

interface ContextState {
  chips: Partial<Record<ChipKind, ChipState>>;
  set: (kind: ChipKind, state: ChipState | null) => void;
  clear: () => void;
}

export const useContextDraft = create<ContextState>((set) => ({
  chips: {},
  set: (kind, state) => {
    set((s) => {
      const chips = { ...s.chips };
      if (state) chips[kind] = state;
      else delete chips[kind]; // eslint-disable-line @typescript-eslint/no-dynamic-delete -- keyed by a closed union
      return { chips };
    });
  },
  clear: () => {
    set({ chips: {} });
  },
}));

export function draftAttachments(chips: ContextState['chips']): Attachment[] {
  return Object.values(chips).flatMap((c) => (c.status === 'ready' ? c.attachments : []));
}

export async function activeTab(): Promise<{
  id: number;
  url: string;
  title: string;
  windowId: number;
} | null> {
  const tab = await currentPageTab();
  if (tab?.id === undefined) return null;
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId };
}

function errorState(kind: ChipKind, err: unknown, origin?: string): ChipState {
  const e = err as Error & { code?: string };
  return {
    kind,
    status: 'error',
    attachments: [],
    error: {
      message: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(origin ? { origin } : {}),
    },
  };
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') ? `${u.protocol}//${u.hostname}/*` : undefined;
  } catch {
    return undefined;
  }
}

/** Load the current page (or just its selection) into a chip. */
export async function loadPageChip(kind: 'page' | 'selection', tabId?: number): Promise<void> {
  const { set } = useContextDraft.getState();
  set(kind, { kind, status: 'loading', attachments: [] });
  const tab =
    tabId === undefined
      ? await activeTab()
      : await browser.tabs.get(tabId).then((t) => ({
          id: tabId,
          url: t.url ?? '',
          title: t.title ?? '',
          windowId: t.windowId,
        }));
  if (!tab) {
    set(kind, errorState(kind, new Error('No active tab')));
    return;
  }
  try {
    const page = await sendMessage('bg:context:page', { tabId: tab.id });
    if (kind === 'selection') {
      if (!page.selection)
        throw new TetherError('E_NO_SELECTION', 'Nothing is selected on the page.');
      set(kind, {
        kind,
        status: 'ready',
        attachments: [toAttachmentFromExtract('selection', { ...page, text: page.selection })],
      });
    } else {
      set(kind, { kind, status: 'ready', attachments: [toAttachmentFromExtract('page', page)] });
    }
  } catch (err) {
    set(kind, errorState(kind, err, originOf(tab.url)));
  }
}

/** Every readable tab in this window; tabs Tether can't read are listed, not silently dropped. */
export async function loadTabsChip(): Promise<void> {
  const { set } = useContextDraft.getState();
  set('tabs', { kind: 'tabs', status: 'loading', attachments: [] });
  try {
    const tabs: TabSummary[] = await sendMessage('bg:context:tabs', {});
    const attachments: Attachment[] = [];
    const skipped: { title: string; reason: string }[] = [];
    await Promise.all(
      tabs.map(async (t) => {
        if (t.access === 'restricted') {
          skipped.push({ title: t.title || t.url, reason: 'browser page' });
          return;
        }
        if (t.isPdf) {
          skipped.push({ title: t.title || t.url, reason: 'PDF (use This PDF)' });
          return;
        }
        try {
          const page = await sendMessage('bg:context:page', { tabId: t.tabId });
          if (page.text.trim()) attachments.push(toAttachmentFromExtract('tab', page));
        } catch {
          skipped.push({ title: t.title || t.url, reason: 'needs permission' });
        }
      }),
    );
    set('tabs', { kind: 'tabs', status: 'ready', attachments, skipped });
  } catch (err) {
    set('tabs', errorState('tabs', err));
  }
}

async function pdfAttachment(
  title: string,
  url: string | undefined,
  bytes: ArrayBuffer,
): Promise<Attachment> {
  const { extractPdfText, hasTextLayer } = await import('@/context/pdf');
  const pdf = await extractPdfText(bytes);
  if (!hasTextLayer(pdf)) {
    throw new TetherError('E_PDF_NO_TEXT', 'This PDF has no text layer (is it a scan?).');
  }
  return toAttachment('pdf', {
    title: pdf.title ?? title,
    ...(url ? { url } : {}),
    text: pdf.truncated ? `${pdf.text}\n\n[PDF text truncated]` : pdf.text,
  });
}

/**
 * "This PDF": re-read the document open in the active tab. The only place
 * Tether contacts a non-model host, so it's user-initiated, limited to
 * exactly this URL, and needs that origin's permission like any page.
 */
export async function loadPdfChip(): Promise<void> {
  const { set } = useContextDraft.getState();
  set('pdf', { kind: 'pdf', status: 'loading', attachments: [] });
  const tab = await activeTab();
  const { pdfSourceUrl } = await import('@/context/pdf-url');
  const url = tab ? pdfSourceUrl(tab.url) : '';
  const origin = originOf(url);
  try {
    if (!tab || !origin)
      throw new TetherError(
        'E_PDF_URL',
        'Tether can only read PDFs opened from a web address. Use Attach PDF for local files.',
      );
    const pdfOrigin = new URL(url).origin;
    const http = new HttpClient({
      isAllowedOrigin: (o) => o === pdfOrigin,
      hasHostPermission: (o) => browser.permissions.contains({ origins: [`${o}/*`] }),
    });
    const res = await http.request(url, { credentials: 'include' });
    set('pdf', {
      kind: 'pdf',
      status: 'ready',
      attachments: [await pdfAttachment(tab.title, url, await res.arrayBuffer())],
    });
  } catch (err) {
    const e = err as { code?: string };
    set(
      'pdf',
      errorState(
        'pdf',
        e.code === 'E_NEEDS_PERMISSION'
          ? new TetherError(
              'E_NO_ACCESS',
              `Tether needs your permission to read ${new URL(url).hostname}.`,
            )
          : err,
        origin,
      ),
    );
  }
}

/** "Attach PDF": a local file, read in the panel. No network. */
export async function loadFileChip(file: File): Promise<void> {
  const { set } = useContextDraft.getState();
  set('file', { kind: 'file', status: 'loading', attachments: [] });
  try {
    set('file', {
      kind: 'file',
      status: 'ready',
      attachments: [await pdfAttachment(file.name, undefined, await file.arrayBuffer())],
    });
  } catch (err) {
    set('file', errorState('file', err));
  }
}
