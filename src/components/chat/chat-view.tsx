import { useEffect, useRef } from 'react';
import {
  editAndResend,
  regenerate,
  sendUserMessage,
  startConversation,
  stopReply,
} from '@/chat/runner';
import { branchConversation, selectBranch, updateConversation } from '@/chat/store';
import { siblingInfo } from '@/chat/tree';
import { useChatUi } from '@/chat/ui-store';
import { ModelPicker } from '@/components/models/model-picker';
import { useActiveTabUrl } from '@/hooks/use-active-tab';
import { useConversation } from '@/hooks/use-conversation';
import { useSettings } from '@/hooks/use-settings';
import { matchSiteRule } from '@/lib/settings';
import { Composer } from './composer';
import { ConversationSettingsButton } from './conversation-settings';
import { MessageItem } from './message-item';

function hostnameOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

const SUGGESTIONS = [
  'Explain this concept like I’m new to it: ',
  'Write a regular expression that matches ',
  'Summarize the trade-offs between ',
];

export function ChatView() {
  const conversationId = useChatUi((s) => s.conversationId);
  const openConversation = useChatUi((s) => s.openConversation);
  const live = useChatUi((s) => s.live);
  const { settings } = useSettings();
  const tabUrl = useActiveTabUrl();
  const { conversation, messages, thread } = useConversation(conversationId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const busyIds = messages.filter((m) => live[m.id]).map((m) => m.id);
  const busy = busyIds.length > 0;
  const rule = !conversation && settings ? matchSiteRule(settings.siteRules, tabUrl) : undefined;

  const stop = () => {
    for (const id of busyIds) stopReply(id);
  };

  // Esc stops generation anywhere in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busyIds.length) {
        for (const id of busyIds) stopReply(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [busyIds]);

  // Follow new tokens unless the user has scrolled up to read.
  const lastContent = thread.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.length, lastContent]);

  const send = async (text: string) => {
    pinnedToBottom.current = true;
    const conv = conversation ?? (await startConversation(tabUrl));
    if (!conversation) openConversation(conv.id);
    await sendUserMessage(conv, text);
  };

  if (!settings) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-3 py-3"
        data-testid="thread"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {thread.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm font-medium">What can I help with?</p>
            <p className="max-w-64 text-xs text-muted">
              Everything runs on your machine. Nothing you type leaves this computer.
            </p>
            {rule && (
              <p className="text-xs text-muted" data-testid="site-rule-hint">
                Using <span className="font-medium text-fg">{rule.model}</span> for{' '}
                {hostnameOf(tabUrl)}
              </p>
            )}
            <div className="flex flex-col gap-1">
              {SUGGESTIONS.map((s) => (
                <span key={s} className="rounded-md bg-surface-2 px-2 py-1 text-xs text-muted">
                  {s}…
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {thread.map((m, i) => {
              const isLast = i === thread.length - 1;
              return (
                <MessageItem
                  key={m.id}
                  message={m}
                  siblings={siblingInfo(messages, m)}
                  {...(live[m.id] ? { live: live[m.id] } : {})}
                  busy={busy}
                  defaultShowReasoning={settings.chat.showReasoning}
                  enterToSend={settings.chat.enterToSend}
                  onSelectSibling={(id) => {
                    if (conversation) void selectBranch(conversation.id, id);
                  }}
                  {...(m.role === 'assistant' && conversation
                    ? {
                        onRegenerate: () => {
                          pinnedToBottom.current = isLast || pinnedToBottom.current;
                          void regenerate(conversation, m);
                        },
                      }
                    : {})}
                  {...(m.role === 'user' && conversation
                    ? {
                        onEdit: (text: string) => {
                          pinnedToBottom.current = true;
                          void editAndResend(conversation, m, text);
                        },
                      }
                    : {})}
                  onBranch={() => {
                    if (!conversation) return;
                    void branchConversation(conversation.id, m.id).then((c) => {
                      openConversation(c.id);
                    });
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        <Composer
          busy={busy}
          disabled={!conversation && !settings.selection.model && !rule}
          enterToSend={settings.chat.enterToSend}
          onSend={(t) => void send(t)}
          onStop={stop}
          toolbar={
            <>
              {conversation ? (
                <ModelPicker
                  compact
                  value={{ instanceId: conversation.instanceId, model: conversation.model }}
                  onChange={(v) => void updateConversation(conversation.id, v)}
                />
              ) : (
                <ModelPicker compact />
              )}
              {conversation && (
                <ConversationSettingsButton conversation={conversation} settings={settings} />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
