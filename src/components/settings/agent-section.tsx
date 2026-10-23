import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { checkUrl } from '@/agent/guard';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { useSettings } from '@/hooks/use-settings';
import type { ToolTierSetting } from '@/lib/settings';
import { platform } from '@/platform/capabilities';
import { NumberField, SwitchRow } from './fields';

const TIERS: { value: ToolTierSetting; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    hint: 'Native tools if the model has them, else constrained JSON, else text.',
  },
  { value: 'native', label: 'Native tool calls', hint: 'The model’s own function-calling.' },
  { value: 'constrained', label: 'Constrained JSON', hint: 'Grammar / JSON-schema decoding.' },
  { value: 'text', label: 'Text protocol', hint: 'Works with any model; slowest.' },
];

function DomainList({
  label,
  items,
  onChange,
  warnDefaults,
  testId,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  warnDefaults?: boolean;
  testId: string;
}) {
  const [draft, setDraft] = useState('');
  const risky = (d: string) =>
    warnDefaults &&
    !checkUrl(`https://${d.replace(/^\*\./, '')}/`, { allowDomains: [], blockDomains: [] }).allowed;
  return (
    <div data-testid={testId}>
      <Label>{label}</Label>
      <ul className="mb-1 space-y-1">
        {items.map((d) => (
          <li key={d} className="flex items-center gap-2 text-sm">
            <span className="font-mono">{d}</span>
            {risky(d) && (
              <span className="inline-flex items-center gap-1 text-[11px] text-danger">
                <AlertTriangle className="size-3" /> normally blocked (banking, payments, government
                or email)
              </span>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label={`Remove ${d}`}
              onClick={() => onChange(items.filter((x) => x !== d))}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const d = draft
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '');
          if (d && !items.includes(d)) onChange([...items, d]);
          setDraft('');
        }}
      >
        <Input
          aria-label={`${label}: add a site`}
          placeholder="example.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="md" variant="outline" disabled={!draft.trim()}>
          <Plus /> Add
        </Button>
      </form>
    </div>
  );
}

/** Whether Tether holds the optional all-sites grant, kept live. */
function useAllSitesAccess(): boolean {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    const check = () => {
      void browser.permissions
        .contains({ origins: ['<all_urls>'] })
        .then(setGranted)
        .catch(() => undefined);
    };
    check();
    browser.permissions.onAdded.addListener(check);
    browser.permissions.onRemoved.addListener(check);
    return () => {
      browser.permissions.onAdded.removeListener(check);
      browser.permissions.onRemoved.removeListener(check);
    };
  }, []);
  return granted;
}

export function AgentSection() {
  const { settings, update } = useSettings();
  const allSites = useAllSitesAccess();
  if (!settings) return null;
  const a = settings.agent;
  const set = (patch: Partial<typeof a>) => void update({ agent: patch });

  // Turning screenshots on asks for all-sites access in the same click:
  // Chrome captures a tab only with it, or on the tab Tether was opened from.
  const chooseVision = async (on: boolean) => {
    set({ vision: on });
    if (on && !allSites) {
      await browser.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    }
  };

  const chooseBackend = async (backend: 'scripting' | 'debugger') => {
    if (backend === 'debugger') {
      // Inside the click: the permission prompt needs the user gesture.
      const ok = await browser.permissions
        .request({ permissions: ['debugger'] })
        .catch(() => false);
      if (!ok) return;
    }
    set({ inputBackend: backend });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>How the agent talks to the model</CardTitle>
        <fieldset className="grid gap-1" data-testid="tool-tier">
          <legend className="sr-only">Tool-calling tier</legend>
          {TIERS.map((t) => (
            <label key={t.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="tool-tier"
                checked={a.toolTier === t.value}
                onChange={() => set({ toolTier: t.value })}
                className="mt-1 accent-accent"
              />
              <span>
                {t.label}
                <span className="block text-xs text-muted">{t.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="mt-3">
          <SwitchRow
            label="Check the answer before finishing"
            description="One extra model call asks whether the task was really done, against the final page. Catches premature “done”."
            checked={a.critique}
            onChange={(v) => set({ critique: v })}
          />
        </div>
        <div className="mt-3" data-testid="vision-settings">
          <SwitchRow
            label="Show the model screenshots"
            description="For models with vision only: each step also sends a screenshot with the element numbers drawn on it. It helps on visual pages, but an image costs several hundred prompt tokens and noticeably slower steps on small machines. The model still answers with element numbers, never screen positions."
            checked={a.vision}
            onChange={(v) => void chooseVision(v)}
          />
          {a.vision && (
            <p className="mt-1 text-xs text-muted" data-testid="vision-access">
              {allSites
                ? 'Tether can capture any tab you allow it to visit.'
                : 'Without access to all sites, screenshots work only on the tab you opened Tether from; other steps use the page text.'}
            </p>
          )}
          {a.vision && (
            <div className="mt-2 max-w-48">
              <NumberField
                id="a-vision-side"
                label="Screenshot size (long side, px)"
                value={a.visionMaxSide}
                min={256}
                max={2048}
                onCommit={(v) => set({ visionMaxSide: v })}
              />
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>How the agent clicks and types</CardTitle>
        <fieldset className="grid gap-2" data-testid="input-backend">
          <legend className="sr-only">Input backend</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="backend"
              checked={a.inputBackend === 'scripting'}
              onChange={() => void chooseBackend('scripting')}
              className="mt-1 accent-accent"
            />
            <span>
              Scripted events (recommended)
              <span className="block text-xs text-muted">
                Works on most sites with no extra permission.
              </span>
            </span>
          </label>
          {platform.debuggerPermission ? (
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="backend"
                checked={a.inputBackend === 'debugger'}
                onChange={() => void chooseBackend('debugger')}
                className="mt-1 accent-accent"
              />
              <span>
                Trusted input (debugger)
                <span className="block text-xs text-muted">
                  For sites that ignore scripted clicks, canvas apps and file pickers. Needs the
                  “debugger” permission; while the agent runs, Chrome shows a “Tether started
                  debugging this browser” bar. You can cancel it there at any time, which also stops
                  trusted input.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted" data-testid="no-trusted-input">
              Trusted input isn’t available in this browser: it relies on Chrome’s debugger API.
              Scripted events are used everywhere.
            </p>
          )}
        </fieldset>
      </Card>

      <Card>
        <CardTitle>Limits</CardTitle>
        <div className="grid grid-cols-3 gap-3">
          <NumberField
            id="a-steps"
            label="Max steps"
            value={a.maxSteps}
            min={1}
            max={100}
            onCommit={(v) => set({ maxSteps: v })}
          />
          <NumberField
            id="a-mins"
            label="Max minutes"
            value={a.maxMinutes}
            min={1}
            max={60}
            onCommit={(v) => set({ maxMinutes: v })}
          />
          <NumberField
            id="a-fails"
            label="Failures in a row"
            value={a.maxConsecutiveFailures}
            min={1}
            max={10}
            onCommit={(v) => set({ maxConsecutiveFailures: v })}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>Where the agent may go</CardTitle>
        <p className="mb-3 text-xs text-muted">
          Banking, payment, government and webmail sites are blocked by default. Anything that buys,
          sends, deletes, submits or publishes always asks you first, wherever it is. The agent
          never types passwords, one-time codes or card details.
        </p>
        <div className="grid gap-4">
          <DomainList
            label="Always allow"
            items={a.allowDomains}
            onChange={(v) => set({ allowDomains: v })}
            warnDefaults
            testId="allow-domains"
          />
          <DomainList
            label="Never visit"
            items={a.blockDomains}
            onChange={(v) => set({ blockDomains: v })}
            testId="block-domains"
          />
        </div>
      </Card>
    </div>
  );
}
