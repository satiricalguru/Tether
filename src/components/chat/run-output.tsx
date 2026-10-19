import { useState } from 'react';
import type { ChatStatus } from '@/background/chat';
import type { ChatRunState } from '@/hooks/use-chat-run';
import { MetricsFooter } from './metrics-footer';

const STATUS_TEXT: Record<ChatStatus, string> = {
  waiting: 'Waiting for the model…',
  'loading-model': 'Loading model into memory… (first use can take up to a minute)',
  slow: 'Processing the prompt…',
  generating: '',
};

const ERROR_HINT: Record<string, string> = {
  E_TOOLS_UNSUPPORTED:
    'This model rejected native tool calls; Tether will use a text protocol for it.',
  E_UNREACHABLE: 'The server stopped responding. Is it still running?',
  E_ORIGIN_BLOCKED:
    'The server rejected the extension’s origin. Open the Setup Doctor for the fix.',
  E_STALLED: 'The model stopped sending tokens.',
};

/** Streaming reply with status, collapsible reasoning, errors and metrics. */
export function RunOutput({ state }: { state: ChatRunState }) {
  const [showReasoning, setShowReasoning] = useState(false);
  if (state.phase === 'idle') return null;
  const statusText = state.phase === 'running' && state.status ? STATUS_TEXT[state.status] : '';

  return (
    <div className="space-y-2" data-testid="run-output" data-phase={state.phase}>
      {state.reasoning && (
        <div>
          <button
            type="button"
            className="text-xs text-muted hover:text-fg"
            onClick={() => {
              setShowReasoning((v) => !v);
            }}
            aria-expanded={showReasoning}
          >
            {showReasoning ? '▾ Hide reasoning' : '▸ Show reasoning'}
          </button>
          {showReasoning && (
            <p
              className="mt-1 border-l-2 border-border pl-2 text-xs whitespace-pre-wrap text-muted"
              data-testid="run-reasoning"
            >
              {state.reasoning}
            </p>
          )}
        </div>
      )}
      {statusText && (
        <p
          className="animate-pulse text-xs text-muted"
          data-testid="run-status"
          data-status={state.status}
        >
          {statusText}
        </p>
      )}
      {state.text && (
        <p className="text-sm whitespace-pre-wrap" data-testid="run-text">
          {state.text}
        </p>
      )}
      {state.toolCalls.map((c) => (
        <pre key={c.id} className="rounded bg-surface-2 p-2 font-mono text-xs">
          {c.name}({c.arguments})
        </pre>
      ))}
      {state.phase === 'stopped' && <p className="text-xs text-muted">Stopped.</p>}
      {state.error && (
        <p className="text-xs text-danger" role="alert">
          {state.error.message}
          {state.error.code && ERROR_HINT[state.error.code] && (
            <span className="block text-muted">{ERROR_HINT[state.error.code]}</span>
          )}
        </p>
      )}
      {state.metrics && <MetricsFooter metrics={state.metrics} />}
    </div>
  );
}
