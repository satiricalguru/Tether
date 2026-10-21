import { useEffect } from 'react';
import { browser } from 'wxt/browser';
import { loadPageChip, useContextDraft } from '@/chat/context-store';
import { sendUserMessage, startConversation } from '@/chat/runner';
import { appendMessage } from '@/chat/store';
import { useChatUi } from '@/chat/ui-store';
import { createLogger } from '@/lib/logger';
import { PENDING_KEY, type PendingAction } from '@/lib/protocol';

const log = createLogger('pending');

/**
 * The panel's inbox. Context menus and the highlight bubble can't drive the
 * panel directly, so they leave one action in storage.session; whichever
 * panel sees it first takes it (removing it) and acts.
 */
export async function takePending(): Promise<PendingAction | undefined> {
  const raw = (await browser.storage.session.get(PENDING_KEY))[PENDING_KEY] as
    PendingAction | undefined;
  if (!raw) return undefined;
  await browser.storage.session.remove(PENDING_KEY);
  // Ignore stale work (a panel that wasn't open for a long time).
  return Date.now() - raw.createdAt < 5 * 60_000 ? raw : undefined;
}

export async function handlePending(action: PendingAction): Promise<void> {
  const ui = useChatUi.getState();
  const draft = useContextDraft.getState();
  switch (action.kind) {
    case 'attach-page': {
      ui.openConversation(null);
      draft.clear();
      await loadPageChip('page', action.tabId);
      return;
    }
    case 'ask': {
      ui.openConversation(null);
      draft.clear();
      if (!action.prompt) {
        // "Ask about selection…": attach it and let the user type.
        draft.set('selection', {
          kind: 'selection',
          status: 'ready',
          attachments: action.attachments,
        });
        return;
      }
      const conv = await startConversation(action.attachments[0]?.url);
      ui.openConversation(conv.id);
      await sendUserMessage(conv, action.prompt, action.attachments);
      return;
    }
    case 'continue': {
      const conv = await startConversation(action.attachments[0]?.url);
      const user = await appendMessage(conv.id, null, {
        role: 'user',
        content: action.prompt,
        attachments: action.attachments,
      });
      await appendMessage(conv.id, user.id, {
        role: 'assistant',
        content: action.answer,
        status: 'done',
        instanceId: conv.instanceId,
        model: conv.model,
      });
      ui.openConversation(conv.id);
      return;
    }
  }
}

export function usePendingActions(): void {
  useEffect(() => {
    const run = () => {
      void takePending()
        .then((a) => (a ? handlePending(a) : undefined))
        .catch((err: unknown) => {
          log.warn('pending action failed', err);
        });
    };
    run();
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && changes[PENDING_KEY]?.newValue) run();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
}
