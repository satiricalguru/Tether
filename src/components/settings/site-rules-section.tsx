import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker } from '@/components/models/model-picker';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { useSettings } from '@/hooks/use-settings';

export function SiteRulesSection() {
  const { settings, update } = useSettings();
  const [pattern, setPattern] = useState('');
  const [pick, setPick] = useState<{ instanceId: string; model: string }>();
  if (!settings) return null;
  const rules = settings.siteRules;

  const add = () => {
    const p = pattern.trim();
    const sel = pick ?? settings.selection;
    if (!p || !sel.model) return;
    void update({ siteRules: [...rules.filter((r) => r.pattern !== p), { pattern: p, ...sel }] });
    setPattern('');
  };

  return (
    <Card>
      <CardTitle>Per-site default model</CardTitle>
      <p className="mb-3 text-xs text-muted">
        New chats started while one of these sites is the active tab use its model, e.g. a coding
        model on github.com. First match wins. Use <code className="font-mono">*.example.com</code>{' '}
        for subdomains.
      </p>
      <ul className="mb-3 divide-y divide-border" data-testid="site-rules">
        {rules.length === 0 && <li className="py-2 text-xs text-muted">No rules yet.</li>}
        {rules.map((r) => (
          <li key={r.pattern} className="flex items-center gap-2 py-2 text-sm">
            <span className="font-mono">{r.pattern}</span>
            <span className="text-muted">→</span>
            <span className="truncate">{r.model}</span>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label={`Remove rule for ${r.pattern}`}
              onClick={() =>
                void update({ siteRules: rules.filter((x) => x.pattern !== r.pattern) })
              }
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div>
          <Label htmlFor="rule-pattern">Site</Label>
          <Input
            id="rule-pattern"
            placeholder="github.com"
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
            }}
          />
        </div>
        <div>
          <Label>Model</Label>
          <ModelPicker value={pick ?? settings.selection} onChange={setPick} />
        </div>
        <Button type="submit" size="md" disabled={!pattern.trim()}>
          <Plus /> Add
        </Button>
      </form>
    </Card>
  );
}
