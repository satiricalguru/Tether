import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { PromptTemplate } from '@/prompts/library';
import { slashSuggestions } from '@/prompts/template';

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  enterToSend: boolean;
  /** Resolve false to keep the text (nothing was sent). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  /** Left side of the toolbar (model picker, chat settings). */
  toolbar: ReactNode;
  /** Rendered above the text box (context chips). */
  above?: ReactNode;
  /** Allow sending with no text (context attached: a default question is used). */
  allowEmpty?: boolean;
  placeholder?: string;
  /** Slash commands offered when the message starts with "/". */
  prompts?: PromptTemplate[];
}

export function Composer({
  busy,
  disabled,
  enterToSend,
  onSend,
  onStop,
  toolbar,
  above,
  allowEmpty = false,
  placeholder,
  prompts = [],
}: ComposerProps) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const suggestions = menuClosed ? [] : slashSuggestions(text, prompts);
  const menuOpen = suggestions.length > 0;
  const pick = (p: PromptTemplate) => {
    setText(`/${p.command} `);
    setActive(0);
    ref.current?.focus();
  };

  // Grow with content up to ~8 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if ((!t && !allowEmpty) || busy || disabled) return;
    setText('');
    void onSend(t).then((sent) => {
      if (!sent) setText((now) => now || t);
    });
  };

  return (
    <form
      className="rounded-xl border border-border bg-surface p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {above}
      {menuOpen && (
        <ul
          id="slash-menu"
          role="listbox"
          aria-label="Prompt library"
          className="mb-1 max-h-48 overflow-y-auto rounded-md border border-border bg-bg p-1 text-sm"
          data-testid="slash-menu"
        >
          {suggestions.map((p, i) => (
            <li
              key={p.id}
              id={`slash-${p.command}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                'flex cursor-pointer items-baseline gap-2 rounded px-2 py-1',
                i === active && 'bg-surface-2',
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              <span className="font-mono text-xs">/{p.command}</span>
              <span className="truncate text-xs text-muted">{p.description ?? p.name}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        aria-label="Message"
        rows={1}
        value={text}
        placeholder={placeholder ?? 'Message your local model…'}
        className="block max-h-[180px] w-full resize-none bg-transparent px-1 text-sm focus:outline-none"
        role={prompts.length ? 'combobox' : undefined}
        aria-expanded={prompts.length ? menuOpen : undefined}
        aria-controls={menuOpen ? 'slash-menu' : undefined}
        aria-activedescendant={menuOpen ? `slash-${suggestions[active]?.command ?? ''}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setMenuClosed(false);
        }}
        onKeyDown={(e) => {
          if (menuOpen && !e.nativeEvent.isComposing) {
            const chosen = suggestions[active];
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((a) => (a + step + suggestions.length) % suggestions.length);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && chosen) {
              e.preventDefault();
              pick(chosen);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setMenuClosed(true);
              return;
            }
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          const sends = enterToSend ? !e.shiftKey : e.metaKey || e.ctrlKey;
          if (sends) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="mt-1 flex items-center gap-1">
        {toolbar}
        {/* Distinct keys: see ADR-015 (a reused <button> flipping to submit resends). */}
        {busy ? (
          <Button
            key="stop"
            type="button"
            size="icon"
            variant="danger"
            className="ml-auto size-7 rounded-full"
            aria-label="Stop"
            onClick={onStop}
          >
            <Square />
          </Button>
        ) : (
          <Button
            key="send"
            type="submit"
            size="icon"
            className="ml-auto size-7 rounded-full"
            aria-label="Send"
            disabled={disabled || (!text.trim() && !allowEmpty)}
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </form>
  );
}
