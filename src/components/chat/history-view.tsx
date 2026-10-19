import { Download, FileJson, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { downloadText, safeFilename, toJson, toMarkdown } from '@/chat/export';
import { conversationMessages, deleteConversation, updateConversation } from '@/chat/store';
import { useChatUi } from '@/chat/ui-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConversationList } from '@/hooks/use-conversation';
import { cn } from '@/lib/cn';
import type { ConversationRecord } from '@/lib/db';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function exportConversation(c: ConversationRecord, kind: 'md' | 'json') {
  const messages = await conversationMessages(c.id);
  if (kind === 'md') {
    downloadText(safeFilename(c.title, 'md'), toMarkdown(c, messages), 'text/markdown');
  } else {
    downloadText(
      safeFilename(c.title, 'json'),
      JSON.stringify(toJson(c, messages), null, 2),
      'application/json',
    );
  }
}

function Row({ c, active }: { c: ConversationRecord; active: boolean }) {
  const openConversation = useChatUi((s) => s.openConversation);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className={cn('group rounded-md px-2 py-1.5 hover:bg-surface-2', active && 'bg-surface-2')}
      data-testid="history-item"
      data-id={c.id}
    >
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void updateConversation(c.id, { title: title.trim() || c.title });
            setRenaming(false);
          }}
        >
          <Input
            aria-label="Conversation title"
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        </form>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => {
              openConversation(c.id);
            }}
            onDoubleClick={() => {
              setTitle(c.title);
              setRenaming(true);
            }}
            title="Open (double-click to rename)"
          >
            <span className="flex items-center gap-1 truncate text-sm">
              {c.pinned === 1 && (
                <Pin className="size-3 shrink-0 text-accent" aria-label="Pinned" />
              )}
              <span className="truncate" data-testid="history-title">
                {c.title}
              </span>
            </span>
            <span className="block truncate text-[11px] text-muted">
              {c.model} · {relativeTime(c.updatedAt)}
            </span>
          </button>
          <span className="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 [&_svg]:size-3.5"
              aria-label={c.pinned ? 'Unpin' : 'Pin'}
              onClick={() => void updateConversation(c.id, { pinned: c.pinned ? 0 : 1 })}
            >
              {c.pinned ? <PinOff /> : <Pin />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 [&_svg]:size-3.5"
              aria-label="Export as Markdown"
              onClick={() => void exportConversation(c, 'md')}
            >
              <Download />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 [&_svg]:size-3.5"
              aria-label="Export as JSON"
              onClick={() => void exportConversation(c, 'json')}
            >
              <FileJson />
            </Button>
            {confirming ? (
              <Button
                variant="danger"
                size="sm"
                className="h-6 px-2"
                onClick={() => {
                  void deleteConversation(c.id).then(() => {
                    if (active) openConversation(null);
                  });
                }}
                onBlur={() => {
                  setConfirming(false);
                }}
                autoFocus
              >
                Delete?
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-6 [&_svg]:size-3.5"
                aria-label="Delete"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                <Trash2 />
              </Button>
            )}
          </span>
        </div>
      )}
    </li>
  );
}

export function HistoryView() {
  const [query, setQuery] = useState('');
  const list = useConversationList(query);
  const activeId = useChatUi((s) => s.conversationId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative border-b border-border p-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted" />
        <Input
          aria-label="Search conversations"
          placeholder="Search conversations"
          className="pl-7"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </div>
      <ul className="flex-1 overflow-y-auto p-1" data-testid="history-list">
        {list?.length === 0 && (
          <li className="p-4 text-center text-xs text-muted">
            {query ? 'No conversations match.' : 'No conversations yet.'}
          </li>
        )}
        {list?.map((c) => (
          <Row key={c.id} c={c} active={c.id === activeId} />
        ))}
      </ul>
    </div>
  );
}
