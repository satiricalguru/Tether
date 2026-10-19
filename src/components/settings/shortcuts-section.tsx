import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

const IN_PANEL: [string, string][] = [
  ['Enter', 'Send (configurable in Composer above)'],
  ['Shift+Enter', 'New line'],
  ['Esc', 'Stop generating'],
];

export function ShortcutsSection() {
  const [commands, setCommands] = useState<
    { name: string; description: string; shortcut: string }[]
  >([]);
  useEffect(() => {
    void browser.commands.getAll().then((all) => {
      setCommands(
        all.map((c) => ({
          name: c.name ?? '',
          // _execute_action has an empty description in Chrome.
          description: c.description?.trim()
            ? c.description
            : c.name === '_execute_action'
              ? 'Open Tether'
              : (c.name ?? ''),
          shortcut: c.shortcut ?? '',
        })),
      );
    });
  }, []);
  const isFirefox = browser.runtime.getURL('/').startsWith('moz-extension:');

  return (
    <Card>
      <CardTitle>Keyboard shortcuts</CardTitle>
      <table className="mb-3 w-full text-sm" data-testid="shortcuts">
        <tbody>
          {commands.map((c) => (
            <tr key={c.name} className="border-b border-border last:border-0">
              <td className="py-1.5">{c.description}</td>
              <td className="py-1.5 text-right font-mono text-xs">
                {c.shortcut || <span className="text-muted">not set</span>}
              </td>
            </tr>
          ))}
          {IN_PANEL.map(([k, d]) => (
            <tr key={k} className="border-b border-border last:border-0">
              <td className="py-1.5">{d}</td>
              <td className="py-1.5 text-right font-mono text-xs">{k}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!isFirefox && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          <ExternalLink /> Change browser shortcuts
        </Button>
      )}
    </Card>
  );
}
