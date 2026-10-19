import { useCallback, useRef, useState } from 'react';
import type { ChatMetrics, ChatStatus, ChatStreamRequest } from '@/background/chat';
import { isAbortError } from '@/lib/errors';
import { openStream, type StreamHandle } from '@/lib/ports';
import type { ToolCall } from '@/providers/types';

export type RunPhase = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export interface ChatRunState {
  phase: RunPhase;
  status?: ChatStatus;
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  metrics?: ChatMetrics;
  error?: { message: string; code?: string };
}

const INITIAL: ChatRunState = { phase: 'idle', text: '', reasoning: '', toolCalls: [] };

/** Run one `chat` stream and fold its events into renderable state. */
export function useChatRun() {
  const [state, setState] = useState<ChatRunState>(INITIAL);
  const handle = useRef<StreamHandle<'chat'>>(null);

  const start = useCallback(async (req: ChatStreamRequest) => {
    handle.current?.abort();
    setState({ ...INITIAL, phase: 'running', status: 'waiting' });
    const stream = openStream('chat', req);
    handle.current = stream;
    try {
      for await (const ev of stream) {
        setState((s) => {
          switch (ev.type) {
            case 'status':
              return { ...s, status: ev.status };
            case 'text':
              return { ...s, text: s.text + ev.text };
            case 'reasoning':
              return { ...s, reasoning: s.reasoning + ev.text };
            case 'reclassify-reasoning':
              return { ...s, reasoning: s.reasoning + s.text, text: '' };
            case 'tool_calls':
              return { ...s, toolCalls: [...s.toolCalls, ...ev.calls] };
            case 'finish':
              return s;
          }
        });
      }
      const { metrics } = await stream.done;
      setState((s) => ({ ...s, phase: 'done', metrics }));
    } catch (err) {
      if (isAbortError(err)) {
        setState((s) => ({ ...s, phase: 'stopped' }));
      } else {
        const e = err as Error & { code?: string };
        setState((s) => ({
          ...s,
          phase: 'error',
          error: { message: e.message, ...(e.code ? { code: e.code } : {}) },
        }));
      }
    } finally {
      if (handle.current === stream) handle.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    handle.current?.abort();
  }, []);

  const reset = useCallback(() => {
    handle.current?.abort();
    setState(INITIAL);
  }, []);

  return { state, start, stop, reset };
}
