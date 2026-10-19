import { Settings as SettingsIcon, Square, Play } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { StatusDot } from '@/components/ui/status-dot';
import { useBackgroundStatus } from '@/hooks/use-background-status';
import { useSettings } from '@/hooks/use-settings';
import { useApplyTheme } from '@/hooks/use-theme';
import { isAbortError } from '@/lib/errors';
import { sendMessage } from '@/lib/messaging';
import { openStream, type StreamHandle } from '@/lib/ports';

type RunState = 'idle' | 'streaming' | 'done' | 'aborted' | 'error';

/**
 * Phase 0 shell. The transport check streams text through the background
 * worker over a port, proving the exact path model output will take.
 */
export function App() {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme);
  const status = useBackgroundStatus();

  const [input, setInput] = useState('Every token is generated on your machine.');
  const [output, setOutput] = useState('');
  const [runState, setRunState] = useState<RunState>('idle');
  const [error, setError] = useState<string>();
  const handle = useRef<StreamHandle<'echo'>>(null);

  const run = async () => {
    setOutput('');
    setError(undefined);
    setRunState('streaming');
    const stream = openStream('echo', { text: input, delayMs: 60 });
    handle.current = stream;
    try {
      for await (const chunk of stream) setOutput((prev) => prev + chunk.token);
      await stream.done;
      setRunState('done');
    } catch (err) {
      if (isAbortError(err)) {
        setRunState('aborted');
      } else {
        setRunState('error');
        setError((err as Error).message);
      }
    } finally {
      handle.current = null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="text-base font-semibold tracking-tight">Tether</h1>
        <span
          className="ml-1 flex items-center gap-1.5 text-xs text-muted"
          data-testid="bg-status"
          data-state={status.state}
        >
          <StatusDot
            status={
              status.state === 'connected' ? 'ok' : status.state === 'error' ? 'error' : 'pending'
            }
          />
          {status.state === 'connected'
            ? `connected · v${status.info.version}`
            : status.state === 'error'
              ? 'background unreachable'
              : 'connecting…'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Open settings"
          onClick={() => void sendMessage('bg:open-options')}
        >
          <SettingsIcon />
        </Button>
      </header>

      <main className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        <Card>
          <CardTitle>Transport check</CardTitle>
          <p className="mb-2 text-xs text-muted">
            Streams your text back token-by-token through the background worker. Chat arrives in
            Phase 2; this verifies the streaming path it will use.
          </p>
          <textarea
            aria-label="Transport check input"
            className="mb-2 w-full resize-none rounded-md border border-border bg-bg p-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
            rows={2}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            {runState === 'streaming' ? (
              <Button variant="danger" size="sm" onClick={() => handle.current?.abort()}>
                <Square /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => void run()} disabled={!input.trim()}>
                <Play /> Run
              </Button>
            )}
            <span className="text-xs text-muted" data-testid="echo-state">
              {runState}
            </span>
          </div>
          <output
            data-testid="echo-output"
            className="mt-2 block min-h-10 rounded-md bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {output}
          </output>
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </Card>
      </main>
    </div>
  );
}
