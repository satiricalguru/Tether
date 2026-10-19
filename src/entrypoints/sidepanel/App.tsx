import { Send, Settings as SettingsIcon, Square, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { AppProviders } from '@/components/app-providers';
import { RunOutput } from '@/components/chat/run-output';
import { SetupDoctor } from '@/components/doctor/setup-doctor';
import { ModelPicker } from '@/components/models/model-picker';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useBackgroundStatus } from '@/hooks/use-background-status';
import { useChatRun } from '@/hooks/use-chat-run';
import { useProviderStatus } from '@/hooks/use-providers';
import { useSettings } from '@/hooks/use-settings';
import { useApplyTheme } from '@/hooks/use-theme';
import { sendMessage } from '@/lib/messaging';

function Header({
  onToggleDoctor,
  doctorOpen,
}: {
  onToggleDoctor: () => void;
  doctorOpen: boolean;
}) {
  const status = useBackgroundStatus();
  return (
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
        variant={doctorOpen ? 'secondary' : 'ghost'}
        size="icon"
        className="ml-auto"
        aria-label="Setup Doctor"
        aria-pressed={doctorOpen}
        onClick={onToggleDoctor}
      >
        <Stethoscope />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open settings"
        onClick={() => void sendMessage('bg:open-options')}
      >
        <SettingsIcon />
      </Button>
    </header>
  );
}

function QuickPrompt() {
  const { settings } = useSettings();
  const { state, start, stop } = useChatRun();
  const [prompt, setPrompt] = useState('');
  const selection = settings?.selection;
  const ready = !!selection?.instanceId && !!selection.model;
  const running = state.phase === 'running';

  const send = () => {
    if (!ready || !prompt.trim()) return;
    void start({
      instanceId: selection.instanceId,
      model: selection.model,
      messages: [{ role: 'user', content: prompt.trim() }],
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <ModelPicker />
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          aria-label="Prompt"
          rows={3}
          value={prompt}
          placeholder="Ask your local model…"
          className="w-full resize-none rounded-md border border-border bg-bg p-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex justify-end">
          {running ? (
            <Button type="button" variant="danger" size="sm" onClick={stop}>
              <Square /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!ready || !prompt.trim()}>
              <Send /> Send
            </Button>
          )}
        </div>
      </form>
      <RunOutput state={state} />
    </div>
  );
}

function Panel() {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme);
  const providers = useProviderStatus();
  const [doctorOpen, setDoctorOpen] = useState(false);
  const anyHealthy = providers.data?.some((p) => p.health?.ok) ?? false;
  const showDoctor = doctorOpen || (!providers.isPending && !anyHealthy);

  return (
    <div className="flex h-full flex-col">
      <Header
        doctorOpen={showDoctor}
        onToggleDoctor={() => {
          setDoctorOpen((v) => !v);
        }}
      />
      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        {showDoctor && <SetupDoctor compact />}
        {anyHealthy && <QuickPrompt />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <AppProviders>
      <Panel />
    </AppProviders>
  );
}
