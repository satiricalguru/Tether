import { Check, ChevronLeft, ChevronRight, Copy, GitBranch, Pencil, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ChatStatus } from '@/background/chat';
import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { MessageRecord } from '@/lib/db';
import type { SiblingInfo } from '@/chat/tree';
import { MetricsFooter } from './metrics-footer';

const STATUS_TEXT: Record<ChatStatus, string> = {
  waiting: 'Waiting for the model…',
  'loading-model': 'Loading model into memory… (first use can take up to a minute)',
  slow: 'Processing the prompt…',
  generating: '',
};

const ERROR_HINT: Record<string, string> = {
  E_UNREACHABLE: 'The model server stopped responding. Is it still running?',
  E_ORIGIN_BLOCKED:
    'The server rejected the extension’s origin. Open the Setup Doctor for the fix.',
  E_STALLED: 'The model stopped sending tokens.',
  E_PROVIDER_DISABLED: 'This conversation’s model server is disabled in settings.',
  E_UNKNOWN_PROVIDER: 'This conversation’s model server no longer exists. Pick another model.',
};

function IconAction({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted hover:text-fg [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconAction
      label={done ? 'Copied' : 'Copy'}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => {
            setDone(false);
          }, 1200);
        })
      }
    >
      {done ? <Check /> : <Copy />}
    </IconAction>
  );
}

function SiblingNav({ info, onSelect }: { info: SiblingInfo; onSelect: (id: string) => void }) {
  if (info.count < 2) return null;
  return (
    <span className="flex items-center text-[11px] text-muted" data-testid="sibling-nav">
      <IconAction
        label="Previous version"
        disabled={!info.prevId}
        onClick={() => {
          if (info.prevId) onSelect(info.prevId);
        }}
      >
        <ChevronLeft />
      </IconAction>
      <span className="tabular-nums" data-testid="sibling-pos">
        {info.index + 1}/{info.count}
      </span>
      <IconAction
        label="Next version"
        disabled={!info.nextId}
        onClick={() => {
          if (info.nextId) onSelect(info.nextId);
        }}
      >
        <ChevronRight />
      </IconAction>
    </span>
  );
}

export interface MessageItemProps {
  message: MessageRecord;
  siblings: SiblingInfo;
  live?: ChatStatus;
  busy: boolean;
  defaultShowReasoning: boolean;
  enterToSend: boolean;
  onSelectSibling: (id: string) => void;
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
  onBranch: () => void;
}

export function MessageItem({
  message: m,
  siblings,
  live,
  busy,
  defaultShowReasoning,
  enterToSend,
  onSelectSibling,
  onRegenerate,
  onEdit,
  onBranch,
}: MessageItemProps) {
  const [showReasoning, setShowReasoning] = useState(defaultShowReasoning);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const streaming = m.status === 'streaming';

  if (m.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1" data-testid="msg-user" data-id={m.id}>
        {editing ? (
          <form
            className="w-full rounded-lg border border-border bg-surface p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              setEditing(false);
              onEdit?.(draft.trim());
            }}
          >
            <textarea
              aria-label="Edit message"
              autoFocus
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              className="w-full resize-none bg-transparent text-sm focus:outline-none"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (enterToSend ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="flex justify-end gap-1">
              <Button
                key="cancel"
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button key="send" type="submit" size="sm" disabled={busy || !draft.trim()}>
                Send
              </Button>
            </div>
          </form>
        ) : (
          <div className="max-w-[90%] rounded-2xl rounded-br-sm bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">
            {m.content}
          </div>
        )}
        {!editing && (
          <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 focus-within:opacity-100">
            <SiblingNav info={siblings} onSelect={onSelectSibling} />
            <CopyAction text={m.content} />
            {onEdit && (
              <IconAction
                label="Edit and resend"
                disabled={busy}
                onClick={() => {
                  setDraft(m.content);
                  setEditing(true);
                }}
              >
                <Pencil />
              </IconAction>
            )}
          </div>
        )}
      </div>
    );
  }

  const statusText = streaming && live ? STATUS_TEXT[live] : '';
  return (
    <div
      className="group flex flex-col gap-1"
      data-testid="msg-assistant"
      data-id={m.id}
      data-status={m.status ?? 'done'}
    >
      {m.reasoning && (
        <div>
          <button
            type="button"
            className="text-xs text-muted hover:text-fg"
            aria-expanded={showReasoning}
            onClick={() => {
              setShowReasoning((v) => !v);
            }}
            data-testid="reasoning-toggle"
          >
            {showReasoning ? '▾' : '▸'} {streaming && !m.content ? 'Thinking…' : 'Reasoning'}
          </button>
          {showReasoning && (
            <div
              className="mt-1 border-l-2 border-border pl-2 text-xs whitespace-pre-wrap text-muted"
              data-testid="reasoning"
            >
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      {statusText && (
        <p className="animate-pulse text-xs text-muted" data-testid="msg-status" data-status={live}>
          {statusText}
        </p>
      )}
      {m.content && <Markdown text={m.content} streaming={streaming} />}
      {streaming && !statusText && !m.content && !m.reasoning && (
        <span className="inline-block h-4 w-2 animate-pulse bg-muted" aria-label="Generating" />
      )}
      {m.status === 'stopped' && <p className="text-xs text-muted">Stopped.</p>}
      {m.status === 'error' && (
        <p className="text-xs text-danger" role="alert" data-testid="msg-error">
          {m.error?.message ?? 'Generation failed'}
          {m.error?.code && ERROR_HINT[m.error.code] && (
            <span className="block text-muted">{ERROR_HINT[m.error.code]}</span>
          )}
        </p>
      )}
      {!streaming && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-0.5 opacity-60 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <SiblingNav info={siblings} onSelect={onSelectSibling} />
          {m.content && <CopyAction text={m.content} />}
          {onRegenerate && (
            <IconAction label="Regenerate" disabled={busy} onClick={onRegenerate}>
              <RotateCcw />
            </IconAction>
          )}
          <IconAction label="Branch into a new chat" onClick={onBranch}>
            <GitBranch />
          </IconAction>
          {m.model && <span className="ml-1 text-[11px] text-muted">{m.model}</span>}
        </div>
      )}
      {m.metrics && !streaming && <MetricsFooter metrics={m.metrics} />}
    </div>
  );
}
