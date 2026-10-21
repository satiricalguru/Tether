import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  enterToSend: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Left side of the toolbar (model picker, chat settings). */
  toolbar: ReactNode;
  /** Rendered above the text box (context chips). */
  above?: ReactNode;
  /** Allow sending with no text (context attached: a default question is used). */
  allowEmpty?: boolean;
  placeholder?: string;
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
}: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

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
    onSend(t);
    setText('');
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
      <textarea
        ref={ref}
        aria-label="Message"
        rows={1}
        value={text}
        placeholder={placeholder ?? 'Message your local model…'}
        className="block max-h-[180px] w-full resize-none bg-transparent px-1 text-sm focus:outline-none"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
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
