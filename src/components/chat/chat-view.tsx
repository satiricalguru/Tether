import { Bot } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  editAndResend,
  regenerate,
  sendUserMessage,
  startAgentRun,
  startConversation,
  stopReply,
} from '@/chat/runner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { branchConversation, selectBranch, updateConversation } from '@/chat/store';
import { siblingInfo } from '@/chat/tree';
import { useChatUi } from '@/chat/ui-store';
import { activeTab, draftAttachments, loadPageChip, useContextDraft } from '@/chat/context-store';
import { TetherMark } from '@/components/brand/tether-mark';
import { ModelPicker } from '@/components/models/model-picker';
import { isPdfUrl } from '@/context/pdf-url';
import { fitAttachments, useContextBudget } from '@/hooks/use-context-budget';
import { usePrompts } from '@/hooks/use-prompts';
import { useActiveTabUrl } from '@/hooks/use-active-tab';
import { useConversation } from '@/hooks/use-conversation';
import { useSettings } from '@/hooks/use-settings';
import { matchSiteRule } from '@/lib/settings';
import { expandTemplate, matchSlash } from '@/prompts/template';
import { withRetrieval } from '@/rag/client';
import { Composer } from './composer';
import { ContextBar } from './context-bar';
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
  const prompts = usePrompts();
  const tabUrl = useActiveTabUrl();
  const { conversation, messages, thread } = useConversation(conversationId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const busyIds = messages.filter((m) => live[m.id]).map((m) => m.id);
  const busy = busyIds.length > 0;
  const rule = !conversation && settings ? matchSiteRule(settings.siteRules, tabUrl) : undefined;
  const chips = useContextDraft((s) => s.chips);
  const clearDraft = useContextDraft((s) => s.clear);
  const drafted = draftAttachments(chips);
  const target = conversation
    ? { instanceId: conversation.instanceId, model: conversation.model }
    : (rule ?? settings?.selection);
  const budget = useContextBudget({
    instanceId: target?.instanceId,
    model: target?.model,
    settings,
    thread,
    attachments: drafted,
    question: '',
  });

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

  const agentMode = useChatUi((s) => s.agentMode);
  const setAgentMode = useChatUi((s) => s.setAgentMode);

  const runAgentTask = async (task: string) => {
    pinnedToBottom.current = true;
    const conv = conversation ?? (await startConversation(tabUrl));
    if (!conversation) openConversation(conv.id);
    // No upfront permission prompt: the run starts with the access Tether
    // has; pages it can't read are reported as such, and the run card
    // offers "Allow on all sites".
    await startAgentRun(conv, task);
  };

  /** Resolves false when nothing was sent (the composer then keeps the text). */
  const send = async (raw: string): Promise<boolean> => {
    if (agentMode && raw) {
      await runAgentTask(raw);
      return true;
    }
    // A /command expands its template and attaches the chips it asks for.
    const slash = matchSlash(raw, prompts);
    const tab = slash ? await activeTab() : null;
    const expanded = slash
      ? expandTemplate(slash.prompt.template, {
          input: slash.input,
          url: tab?.url ?? tabUrl ?? '',
          title: tab?.title ?? '',
        })
      : null;
    if (expanded) {
      const loading: Promise<void>[] = [];
      if (expanded.needs.page && chips.page?.status !== 'ready') loading.push(loadPageChip('page'));
      if (expanded.needs.selection && chips.selection?.status !== 'ready')
        loading.push(loadPageChip('selection'));
      await Promise.all(loading);
      // A chip that failed (nothing selected, page unreadable) shows why; send nothing.
      const now = useContextDraft.getState().chips;
      if (
        (expanded.needs.page && now.page?.status !== 'ready') ||
        (expanded.needs.selection && now.selection?.status !== 'ready')
      )
        return false;
    }
    const text = expanded?.question ?? raw;
    pinnedToBottom.current = true;
    // Chips loaded just now aren't in this render's budget yet: fit them here.
    const fittedNow =
      expanded && budget
        ? fitAttachments(
            draftAttachments(useContextDraft.getState().chips),
            budget.available,
            budget.window,
          )
        : budget;
    // Attachments as budgeted (trimmed to fit), captured before the draft resets.
    const attachments = fittedNow?.fitted ?? drafted;
    const question =
      text ||
      (attachments.some((a) => a.kind === 'selection') ? 'Explain this.' : 'Summarize this.');
    const originals = draftAttachments(useContextDraft.getState().chips);
    clearDraft();
    // Long pages cut to fit: send the parts relevant to the question instead.
    const sent = await withRetrieval(attachments, originals, question, target?.instanceId ?? '');
    const conv = conversation ?? (await startConversation(tabUrl));
    if (!conversation) openConversation(conv.id);
    await sendUserMessage(conv, question, sent);
    return true;
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
            <TetherMark size={44} className="text-fg" />
            <p className="text-base font-semibold">What can I help with?</p>
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
          above={
            <ContextBar
              budget={budget}
              pdfAvailable={isPdfUrl(tabUrl)}
              instanceId={target?.instanceId}
            />
          }
          allowEmpty={drafted.length > 0}
          busy={busy}
          disabled={!conversation && !settings.selection.model && !rule}
          enterToSend={settings.chat.enterToSend}
          onSend={send}
          prompts={agentMode ? [] : prompts}
          placeholder={
            agentMode ? 'Describe a task, e.g. “find the cheapest boots on this site”' : undefined
          }
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
              <Button
                type="button"
                variant={agentMode ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('h-7 px-2 text-xs', agentMode ? 'text-accent' : 'text-muted')}
                aria-pressed={agentMode}
                aria-label="Agent mode"
                title="Agent mode: Tether browses to complete the task"
                onClick={() => {
                  setAgentMode(!agentMode);
                }}
              >
                <Bot /> Agent
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
