import type { ReactNode } from 'react';
import { AppProviders } from '@/components/app-providers';
import { ProvidersSection } from '@/components/providers/providers-section';
import { ChatSection } from '@/components/settings/chat-section';
import { DataSection } from '@/components/settings/data-section';
import { PageSection } from '@/components/settings/page-section';
import { ShortcutsSection } from '@/components/settings/shortcuts-section';
import { SiteRulesSection } from '@/components/settings/site-rules-section';
import { Card, CardTitle } from '@/components/ui/card';
import { useSettings } from '@/hooks/use-settings';
import { useApplyTheme } from '@/hooks/use-theme';
import type { Theme } from '@/lib/settings';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const SECTIONS: [string, string][] = [
  ['models', 'Models'],
  ['chat', 'Chat'],
  ['pages', 'Pages'],
  ['sites', 'Sites'],
  ['shortcuts', 'Shortcuts'],
  ['data', 'Data'],
  ['appearance', 'Appearance'],
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mb-8 scroll-mt-4" aria-labelledby={`${id}-title`}>
      <h2
        id={`${id}-title`}
        className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Options() {
  const { settings, update } = useSettings();
  useApplyTheme(settings?.theme);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Tether settings</h1>
      <p className="mb-6 text-sm text-muted">
        Everything here is stored locally in this browser profile.
      </p>

      <nav className="mb-6 flex flex-wrap gap-3 text-sm" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="text-muted hover:text-fg">
            {label}
          </a>
        ))}
      </nav>

      <Section id="models" title="Models">
        <ProvidersSection />
      </Section>
      <Section id="chat" title="Chat">
        <ChatSection />
      </Section>
      <Section id="pages" title="Pages">
        <PageSection />
      </Section>
      <Section id="sites" title="Sites">
        <SiteRulesSection />
      </Section>
      <Section id="shortcuts" title="Shortcuts">
        <ShortcutsSection />
      </Section>
      <Section id="data" title="Data">
        <DataSection />
      </Section>

      <Section id="appearance" title="Appearance">
        <Card>
          <CardTitle>Theme</CardTitle>
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
      </Section>
    </div>
  );
}

export function App() {
  return (
    <AppProviders>
      <Options />
    </AppProviders>
  );
}
