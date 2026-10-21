import { ArrowLeft, History, Settings as SettingsIcon, SquarePen, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { activeReplyIds, stopAll } from '@/chat/runner';
import { recoverInterrupted } from '@/chat/store';
import { useChatUi } from '@/chat/ui-store';
import { AppProviders } from '@/components/app-providers';
import { ChatView } from '@/components/chat/chat-view';
import { HistoryView } from '@/components/chat/history-view';
import { SetupDoctor } from '@/components/doctor/setup-doctor';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useBackgroundStatus } from '@/hooks/use-background-status';
import { useConversation } from '@/hooks/use-conversation';
import { usePendingActions } from '@/hooks/use-pending-actions';
import { useProviderStatus } from '@/hooks/use-providers';
import { useSettings } from '@/hooks/use-settings';
import { useApplyTheme } from '@/hooks/use-theme';
import { sendMessage } from '@/lib/messaging';

function Header({
  doctorOpen,
  onToggleDoctor,
}: {
  doctorOpen: boolean;
  onToggleDoctor: () => void;
}) {
  const status = useBackgroundStatus();
  const { view, setView, conversationId, openConversation } = useChatUi();
  const { conversation } = useConversation(conversationId);
  const inHistory = view === 'history';

  return (
    <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon"
        aria-label={inHistory ? 'Back to chat' : 'History'}
        onClick={() => {
          setView(inHistory ? 'chat' : 'history');
        }}
      >
        {inHistory ? <ArrowLeft /> : <History />}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span data-testid="bg-status" data-state={status.state}>
          <StatusDot
            status={
              status.state === 'connected' ? 'ok' : status.state === 'error' ? 'error' : 'pending'
            }
          />
        </span>
        <h1
          className="truncate text-sm font-semibold"
          data-testid="panel-title"
          title={
            status.state === 'connected'
              ? `Tether v${status.info.version}`
              : 'Background worker unreachable'
          }
        >
          {inHistory ? 'History' : (conversation?.title ?? 'Tether')}
        </h1>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="New chat"
        onClick={() => {
          openConversation(null);
        }}
      >
        <SquarePen />
      </Button>
      <Button
        variant={doctorOpen ? 'secondary' : 'ghost'}
        size="icon"
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

function Panel() {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme);
  const providers = useProviderStatus();
  const view = useChatUi((s) => s.view);
  const [doctorOpen, setDoctorOpen] = useState(false);
  usePendingActions();
  const anyHealthy = providers.data?.some((p) => p.health?.ok) ?? false;
  const showDoctor = doctorOpen || (!providers.isPending && !anyHealthy);

  // Replies left "streaming" by a panel that closed mid-generation can't finish.
  useEffect(() => {
    void recoverInterrupted(activeReplyIds());
    const onHide = () => {
      stopAll();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header
        doctorOpen={showDoctor}
        onToggleDoctor={() => {
          setDoctorOpen((v) => !v);
        }}
      />
      {showDoctor && (
        <div className="max-h-[60%] shrink-0 overflow-y-auto border-b border-border p-3">
          <SetupDoctor compact />
        </div>
      )}
      {view === 'history' ? <HistoryView /> : <ChatView />}
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
