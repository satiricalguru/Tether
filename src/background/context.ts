import { browser } from 'wxt/browser';
import { fence, UNTRUSTED_RULE, type Attachment } from '@/context/attachments';
import { toAttachment } from '@/context/build';
import type { PageExtract } from '@/context/extract';
import { isPdfUrl } from '@/context/pdf-url';
import { TetherError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { HandlerMap } from '@/lib/messaging';
import { sendToTab } from '@/lib/messaging';
import type { StreamHandler } from '@/lib/ports';
import { PENDING_KEY, type PendingAction, type TabAccess, type TabSummary } from '@/lib/protocol';
import { getSettings, matchSiteRule } from '@/lib/settings';
import { openPanel } from '@/platform/sidePanel';
import { quickInstruction, translationTarget, type QuickAction } from '@/prompting/actions';
import type { ChatStreamRequest } from './chat';

const log = createLogger('context');

const CONTENT_SCRIPT = '/content-scripts/content.js';
const REGISTERED_ID = 'tether-bridge';

/** Pages no extension may script. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|chrome-search|chrome-untrusted):/i.test(
      url,
    ) ||
    /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(
      url,
    )
  );
}

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function hasOriginAccess(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  return browser.permissions.contains({ origins: [pattern] });
}

export async function tabAccess(tab: { url?: string }): Promise<TabAccess> {
  if (isRestrictedUrl(tab.url)) return 'restricted';
  // activeTab grants can't be queried; an explicit grant can.
  return (await hasOriginAccess(tab.url ?? '')) ? 'granted' : 'needs-permission';
}

async function bridgeAlive(tabId: number): Promise<boolean> {
  try {
    await sendToTab(tabId, 'content:ping', undefined, 0);
    return true;
  } catch {
    return false;
  }
}

/** Make sure the bridge runs in the tab; throws E_NO_ACCESS / E_RESTRICTED. */
export async function ensureBridge(tabId: number): Promise<void> {
  if (await bridgeAlive(tabId)) return;
  const tab = await browser.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new TetherError('E_RESTRICTED', 'Browsers don’t let extensions read this kind of page.');
  }
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (err) {
    const origin = originPattern(tab.url ?? '');
    throw new TetherError(
      'E_NO_ACCESS',
      origin
        ? `Tether needs your permission to read ${new URL(tab.url ?? '').hostname}.`
        : 'Tether can’t read this page.',
      { cause: err },
    );
  }
}

export async function extractTab(tabId: number): Promise<PageExtract> {
  await ensureBridge(tabId);
  return sendToTab(tabId, 'content:extract', {}, 0);
}

// ---------- pending actions (panel inbox) ----------

export async function putPending(action: PendingAction): Promise<void> {
  await browser.storage.session.set({ [PENDING_KEY]: action });
}

/**
 * Open the side panel. Must run before any `await` inside a user-gesture
 * handler (context menu click). Returns false where the browser refused.
 */
export function openPanelNow(windowId: number | undefined): Promise<boolean> {
  if (windowId === undefined) return Promise.resolve(false);
  return openPanel(windowId).then(
    () => true,
    (err: unknown) => {
      log.debug('could not open panel', err);
      return false;
    },
  );
}

// ---------- quick actions ----------

export interface QuickDeps {
  chat: StreamHandler<'chat'>;
  capabilities: (instanceId: string, model: string) => Promise<{ thinking?: boolean }>;
}

export async function buildQuickRequest(req: {
  action: QuickAction;
  selection: string;
  question?: string;
  url: string;
  title: string;
}): Promise<{ request: ChatStreamRequest; prompt: string; attachment: Attachment }> {
  const s = await getSettings();
  const pick = matchSiteRule(s.siteRules, req.url) ?? s.selection;
  if (!pick.instanceId || !pick.model) {
    throw new TetherError('E_NO_MODEL', 'Open the Tether side panel and choose a model first.');
  }
  const attachment = toAttachment('selection', {
    title: req.title,
    url: req.url,
    text: req.selection,
  });
  const prompt = quickInstruction(req.action, {
    language: translationTarget(s.page.translateTo, browser.i18n.getUILanguage()),
    ...(req.question ? { question: req.question } : {}),
  });
  const request: ChatStreamRequest = {
    instanceId: pick.instanceId,
    model: pick.model,
    messages: [
      { role: 'system', content: `${s.systemPrompt}\n\n${UNTRUSTED_RULE}` },
      { role: 'user', content: `${fence(attachment)}\n\n${prompt}` },
    ],
    options: {
      temperature:
        req.action === 'translate' || req.action === 'improve' ? 0.3 : s.generation.temperature,
      maxTokens: Math.min(s.generation.maxTokens, 1024),
      topP: s.generation.topP,
      ...(s.generation.numCtx > 0 ? { numCtx: s.generation.numCtx } : {}),
    },
    // Quick answers should be quick.
    think: false,
  };
  return { request, prompt, attachment };
}

export function createQuickStream(deps: QuickDeps): StreamHandler<'quick'> {
  return async function* quick(req, ctx) {
    const { request, prompt } = await buildQuickRequest(req);
    const caps = await deps.capabilities(request.instanceId, request.model).catch(() => undefined);
    // `think: false` only means something to thinking models (others may reject it).
    if (!caps?.thinking) delete request.think;
    const done = yield* deps.chat(request, ctx);
    return { ...done, prompt };
  };
}

// ---------- context menus ----------

type MenuContext = 'selection' | 'page' | 'editable';

/** Opens inline compose on the field that was right-clicked. */
export const COMPOSE_MENU_ID = 'tether-compose';

const MENU: { id: string; title: string; contexts: [MenuContext] }[] = [
  { id: 'tether-sel', title: 'Tether', contexts: ['selection'] },
  { id: 'tether-sel:explain', title: 'Explain', contexts: ['selection'] },
  { id: 'tether-sel:summarize', title: 'Summarize', contexts: ['selection'] },
  { id: 'tether-sel:translate', title: 'Translate', contexts: ['selection'] },
  { id: 'tether-sel:improve', title: 'Improve writing', contexts: ['selection'] },
  { id: 'tether-sel:ask', title: 'Ask about selection…', contexts: ['selection'] },
  { id: 'tether-page', title: 'Ask Tether about this page', contexts: ['page'] },
  { id: COMPOSE_MENU_ID, title: 'Compose with Tether', contexts: ['editable'] },
];

export async function setupContextMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  for (const item of MENU) {
    const parentId = item.id.startsWith('tether-sel:') ? 'tether-sel' : undefined;
    browser.contextMenus.create({
      id: item.id,
      title: item.title,
      contexts: item.contexts,
      ...(parentId ? { parentId } : {}),
    });
  }
}

/**
 * "Compose with Tether" on a text field. The menu click grants activeTab, so
 * this works on sites Tether isn't registered on. A field inside a frame
 * gets the bridge in that frame only.
 */
export async function openComposeFromMenu(tabId: number, frameId: number): Promise<void> {
  try {
    if (frameId === 0) await ensureBridge(tabId);
    else {
      // The bridge keeps one live instance per frame, so injecting again is harmless.
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: [CONTENT_SCRIPT],
      });
    }
    await sendToTab(tabId, 'content:compose-open', undefined, frameId);
  } catch (err) {
    log.warn('could not open compose', err);
  }
}

export interface MenuClick {
  menuItemId: string | number;
  selectionText?: string;
}

/** Turn a menu click into a pending action for the panel. */
export async function pendingFromMenu(
  info: MenuClick,
  tab: { id?: number; url?: string; title?: string } | undefined,
): Promise<PendingAction | null> {
  const id = String(info.menuItemId);
  const createdAt = Date.now();
  if (id === 'tether-page' && tab?.id !== undefined) {
    return { id: crypto.randomUUID(), kind: 'attach-page', tabId: tab.id, createdAt };
  }
  const action = id.startsWith('tether-sel:')
    ? (id.slice('tether-sel:'.length) as QuickAction)
    : null;
  if (!action || !info.selectionText) return null;
  const s = await getSettings();
  const attachment = toAttachment('selection', {
    title: tab?.title ?? '',
    ...(tab?.url ? { url: tab.url } : {}),
    text: info.selectionText,
  });
  const prompt =
    action === 'ask'
      ? ''
      : quickInstruction(action, {
          language: translationTarget(s.page.translateTo, browser.i18n.getUILanguage()),
        });
  return { id: crypto.randomUUID(), kind: 'ask', prompt, attachments: [attachment], createdAt };
}

// ---------- dynamic registration (highlight bubble, inline compose) ----------

/**
 * Register the bridge on every http(s) origin Tether may read, so the bubble
 * and Cmd/Ctrl+K compose work there without a click. With only the default localhost access,
 * that's just local pages; "Allow on all sites" extends it everywhere.
 */
export async function syncRegistration(): Promise<string[]> {
  const s = await getSettings();
  const granted = (await browser.permissions.getAll()).origins ?? [];
  const matches =
    s.page.bubble || s.page.compose
      ? granted.filter((o) => /^(https?|\*):\/\//.test(o) || o === '<all_urls>')
      : [];
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [REGISTERED_ID] });
  if (matches.length === 0) {
    if (existing.length) await browser.scripting.unregisterContentScripts({ ids: [REGISTERED_ID] });
    return [];
  }
  const script = {
    id: REGISTERED_ID,
    matches,
    js: [CONTENT_SCRIPT.slice(1)],
    runAt: 'document_idle' as const,
    allFrames: false,
  };
  if (existing.length) await browser.scripting.updateContentScripts([script]);
  else await browser.scripting.registerContentScripts([script]);
  return matches;
}

// ---------- handlers ----------

export function contextHandlers(): HandlerMap {
  return {
    'bg:context:page': ({ tabId }) => extractTab(tabId),
    'bg:context:tabs': async ({ windowId }) => {
      const tabs = await browser.tabs.query(
        windowId === undefined ? { currentWindow: true } : { windowId },
      );
      return Promise.all(
        tabs
          .filter((t): t is typeof t & { id: number } => t.id !== undefined)
          .map(async (t): Promise<TabSummary> => ({
            tabId: t.id,
            windowId: t.windowId,
            title: t.title ?? '',
            url: t.url ?? '',
            active: t.active,
            access: await tabAccess(t),
            isPdf: isPdfUrl(t.url),
          })),
      );
    },
    'bg:pending:continue': async (req, sender) => {
      const attachment = toAttachment('selection', {
        title: req.title,
        url: req.url,
        text: req.selection,
      });
      // The click in the page is a user gesture; Chrome may honour it here.
      const opened = await openPanelNow(sender.tab?.windowId);
      await putPending({
        id: crypto.randomUUID(),
        kind: 'continue',
        prompt: req.prompt,
        answer: req.answer,
        attachments: [attachment],
        createdAt: Date.now(),
      });
      return { opened };
    },
  };
}
