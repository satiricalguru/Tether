import { Card, CardTitle } from '@/components/ui/card';
import { useSettings } from '@/hooks/use-settings';
import { useApplyTheme } from '@/hooks/use-theme';
import type { Theme } from '@/lib/settings';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function App() {
  const { settings, update } = useSettings();
  useApplyTheme(settings?.theme);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Tether settings</h1>
      <p className="mb-6 text-sm text-muted">
        Everything here is stored locally in this browser profile.
      </p>

      <Card>
        <CardTitle>Appearance</CardTitle>
        {settings ? (
          <fieldset className="flex gap-2" data-testid="theme-picker">
            <legend className="mb-2 text-xs text-muted">Theme</legend>
            {THEMES.map((t) => (
              <label
                key={t.value}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm has-checked:border-accent has-checked:bg-surface-2"
              >
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={settings.theme === t.value}
                  onChange={() => void update({ theme: t.value })}
                  className="accent-accent"
                />
                {t.label}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </Card>
    </div>
  );
}
