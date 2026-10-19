import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { useSettings } from '@/hooks/use-settings';
import { DEFAULT_SYSTEM_PROMPT, type ReasoningMode } from '@/lib/settings';
import { NumberField, SwitchRow } from './fields';

const REASONING: { value: ReasoningMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Model default', hint: 'Let each model decide.' },
  {
    value: 'on',
    label: 'Think',
    hint: 'Ask reasoning models to think first (slower, often better).',
  },
  { value: 'off', label: 'Don’t think', hint: 'Answer directly (faster).' },
];

export function ChatSection() {
  const { settings, update } = useSettings();
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  if (!settings) return null;
  const g = settings.generation;
  const setGen = (patch: Partial<typeof g>) => void update({ generation: patch });

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Generation defaults</CardTitle>
        <p className="mb-3 text-xs text-muted">
          Used by every chat unless the chat overrides them (sliders icon in the composer).
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="generation-settings">
          <NumberField
            id="g-temp"
            label="Temperature"
            value={g.temperature}
            min={0}
            max={2}
            step={0.05}
            onCommit={(v) => setGen({ temperature: v })}
            hint="0 = deterministic, 1 = creative"
          />
          <NumberField
            id="g-topp"
            label="Top-p"
            value={g.topP}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) => setGen({ topP: v })}
          />
          <NumberField
            id="g-max"
            label="Max reply tokens"
            value={g.maxTokens}
            min={16}
            max={65536}
            onCommit={(v) => setGen({ maxTokens: v })}
          />
          <NumberField
            id="g-ctx"
            label="Context window (num_ctx)"
            value={g.numCtx}
            min={0}
            max={1048576}
            onCommit={(v) => setGen({ numCtx: v })}
            hint="0 = server default. Larger uses more memory; changing it makes Ollama reload the model."
          />
          <NumberField
            id="g-seed"
            label="Seed"
            value={g.seed}
            min={-1}
            max={2 ** 31 - 1}
            onCommit={(v) => setGen({ seed: v })}
            hint="-1 = random"
          />
        </div>
      </Card>

      <Card>
        <CardTitle>System prompt</CardTitle>
        <textarea
          aria-label="System prompt"
          rows={4}
          value={promptDraft ?? settings.systemPrompt}
          onChange={(e) => {
            setPromptDraft(e.target.value);
          }}
          onBlur={() => {
            if (promptDraft !== null && promptDraft !== settings.systemPrompt) {
              void update({ systemPrompt: promptDraft });
            }
            setPromptDraft(null);
          }}
          className="w-full resize-y rounded-md border border-border bg-bg p-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <div className="mt-1 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={settings.systemPrompt === DEFAULT_SYSTEM_PROMPT}
            onClick={() => void update({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
          >
            Reset to default
          </Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Reasoning</CardTitle>
        <fieldset className="mb-3 grid gap-1" data-testid="reasoning-mode">
          <legend className="sr-only">Reasoning mode</legend>
          {REASONING.map((r) => (
            <label key={r.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="reasoning"
                value={r.value}
                checked={settings.reasoning === r.value}
                onChange={() => void update({ reasoning: r.value })}
                className="mt-1 accent-accent"
              />
              <span>
                {r.label}
                <span className="block text-xs text-muted">{r.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <SwitchRow
          label="Show reasoning expanded"
          description="Reasoning is never sent back to the model either way."
          checked={settings.chat.showReasoning}
          onChange={(v) => void update({ chat: { showReasoning: v } })}
        />
      </Card>

      <Card>
        <CardTitle>Composer</CardTitle>
        <SwitchRow
          label="Enter sends"
          description={
            settings.chat.enterToSend
              ? 'Shift+Enter for a new line.'
              : 'Ctrl/Cmd+Enter sends; Enter adds a new line.'
          }
          checked={settings.chat.enterToSend}
          onChange={(v) => void update({ chat: { enterToSend: v } })}
        />
        <Label className="sr-only">Composer</Label>
      </Card>
    </div>
  );
}
