import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { updateConversation } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ConversationRecord } from '@/lib/db';
import type { Settings } from '@/lib/settings';

/** Per-conversation overrides; blank fields fall back to the global defaults. */
export function ConversationSettingsButton({
  conversation,
  settings,
}: {
  conversation: ConversationRecord;
  settings: Settings;
}) {
  const [open, setOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');

  const load = () => {
    const s = conversation.settings;
    setSystemPrompt(s.systemPrompt ?? '');
    setTemperature(s.temperature === undefined ? '' : String(s.temperature));
    setMaxTokens(s.maxTokens === undefined ? '' : String(s.maxTokens));
  };

  const save = async () => {
    const t = Number.parseFloat(temperature);
    const mt = Number.parseInt(maxTokens, 10);
    await updateConversation(conversation.id, {
      settings: {
        ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        ...(Number.isFinite(t) ? { temperature: Math.min(2, Math.max(0, t)) } : {}),
        ...(Number.isFinite(mt) && mt > 0 ? { maxTokens: mt } : {}),
      },
    });
    setOpen(false);
  };

  const overridden = Object.keys(conversation.settings).length > 0;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) load();
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={overridden ? 'text-accent' : 'text-muted'}
          aria-label="Chat settings"
          title={overridden ? 'Chat settings (customized)' : 'Chat settings'}
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-xs font-semibold">This chat only</p>
          <div>
            <Label htmlFor="conv-system">System prompt</Label>
            <textarea
              id="conv-system"
              rows={4}
              value={systemPrompt}
              placeholder={settings.systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
              }}
              className="w-full resize-y rounded-md border border-border bg-bg p-2 text-xs focus:ring-2 focus:ring-ring focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="conv-temp">Temperature</Label>
              <Input
                id="conv-temp"
                inputMode="decimal"
                value={temperature}
                placeholder={String(settings.generation.temperature)}
                onChange={(e) => {
                  setTemperature(e.target.value);
                }}
              />
            </div>
            <div>
              <Label htmlFor="conv-max">Max tokens</Label>
              <Input
                id="conv-max"
                inputMode="numeric"
                value={maxTokens}
                placeholder={String(settings.generation.maxTokens)}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSystemPrompt('');
                setTemperature('');
                setMaxTokens('');
              }}
            >
              Use defaults
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
