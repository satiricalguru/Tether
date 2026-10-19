import { Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { downloadText, toJson } from '@/chat/export';
import { conversationMessages, listConversations, wipeConversations } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { useConversationList } from '@/hooks/use-conversation';
import { sendMessage } from '@/lib/messaging';
import { resetSettings } from '@/lib/settings';

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState(false);
  return armed ? (
    <Button
      key="confirm"
      size="sm"
      variant="danger"
      autoFocus
      onBlur={() => {
        setArmed(false);
      }}
      onClick={() => {
        void onConfirm().then(() => {
          setArmed(false);
          setDone(true);
        });
      }}
    >
      {confirmLabel}
    </Button>
  ) : (
    <Button
      key="arm"
      size="sm"
      variant="outline"
      onClick={() => {
        setDone(false);
        setArmed(true);
      }}
    >
      <Trash2 /> {done ? 'Done' : label}
    </Button>
  );
}

export function DataSection() {
  const count = useConversationList('')?.length ?? 0;

  const exportAll = async () => {
    const convs = await listConversations();
    const all = await Promise.all(
      convs.map(async (c) => toJson(c, await conversationMessages(c.id))),
    );
    downloadText(
      `tether-conversations-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(all, null, 2),
      'application/json',
    );
  };

  return (
    <Card>
      <CardTitle>Your data</CardTitle>
      <p className="mb-3 text-xs text-muted">
        Conversations live in this browser profile’s IndexedDB; settings in extension storage.
        Nothing is synced or uploaded. {count} conversation{count === 1 ? '' : 's'} stored.
      </p>
      <div className="flex flex-wrap gap-2" data-testid="data-actions">
        <Button size="sm" variant="outline" onClick={() => void exportAll()} disabled={count === 0}>
          <Download /> Export all conversations (JSON)
        </Button>
        <ConfirmButton
          label="Delete all conversations"
          confirmLabel={`Delete ${count} conversations?`}
          onConfirm={wipeConversations}
        />
        <ConfirmButton
          label="Reset all settings"
          confirmLabel="Reset settings and endpoints?"
          onConfirm={async () => {
            await resetSettings();
            await sendMessage('bg:providers:reset-overrides', {});
          }}
        />
      </div>
    </Card>
  );
}
