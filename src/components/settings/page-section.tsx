import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { useSettings } from '@/hooks/use-settings';
import { SwitchRow } from './fields';
import { RagCard } from './rag-card';

const ALL_SITES = { origins: ['<all_urls>'] };

/** Which sites Tether may read, the highlight bubble and inline compose. */
export function PageSection() {
  const { settings, update } = useSettings();
  const [allSites, setAllSites] = useState<boolean>();
  const [sites, setSites] = useState<string[]>([]);
  const [translateDraft, setTranslateDraft] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      void browser.permissions.contains(ALL_SITES).then(setAllSites);
      void browser.permissions.getAll().then((p) => {
        setSites(
          (p.origins ?? []).filter(
            (o) => o !== '<all_urls>' && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])\//.test(o),
          ),
        );
      });
    };
    read();
    browser.permissions.onAdded.addListener(read);
    browser.permissions.onRemoved.addListener(read);
    return () => {
      browser.permissions.onAdded.removeListener(read);
      browser.permissions.onRemoved.removeListener(read);
    };
  }, []);

  if (!settings) return null;

  return (
    <>
      <Card>
        <CardTitle>Reading pages</CardTitle>
        <p className="mb-3 text-xs text-muted">
          Tether can read a page right after you open it there (toolbar button, shortcut or
          right-click). To read sites at any time, and to show the highlight bubble on them, allow
          them here. Reading a page never sends it anywhere except your own model server.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="site-access">
          {allSites ? (
            <>
              <span className="inline-flex items-center gap-1 text-sm text-ok">
                <ShieldCheck className="size-4" /> Allowed on all sites
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void browser.permissions.remove(ALL_SITES)}
              >
                <ShieldOff /> Revoke
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void browser.permissions.request(ALL_SITES)}
            >
              <ShieldCheck /> Allow on all sites
            </Button>
          )}
        </div>
        {sites.length > 0 && (
          <ul className="mb-3 divide-y divide-border text-sm" data-testid="allowed-sites">
            {sites.map((o) => (
              <li key={o} className="flex items-center py-1.5">
                <span className="font-mono text-xs">{o.replace(/\/\*$/, '')}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Revoke ${o}`}
                  onClick={() => void browser.permissions.remove({ origins: [o] })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        <SwitchRow
          label="Highlight-to-ask bubble"
          description="Select text on an allowed site to explain, summarize, translate or improve it in place."
          checked={settings.page.bubble}
          onChange={(v) => void update({ page: { bubble: v } })}
        />
        <SwitchRow
          label="Inline compose (⌘/Ctrl+K in a text field)"
          description="Rewrite, shorten, fix or re-tone what you're typing on an allowed site, with a preview before anything changes. On other sites, right-click a field → Compose with Tether."
          checked={settings.page.compose}
          onChange={(v) => void update({ page: { compose: v } })}
        />
        <div className="mt-2 max-w-xs">
          <Label htmlFor="translate-to">Translate into</Label>
          <Input
            id="translate-to"
            placeholder={
              new Intl.DisplayNames(['en'], { type: 'language' }).of(
                browser.i18n.getUILanguage().split('-')[0] ?? 'en',
              ) ?? 'English'
            }
            value={translateDraft ?? settings.page.translateTo}
            onChange={(e) => {
              setTranslateDraft(e.target.value);
            }}
            onBlur={() => {
              if (translateDraft !== null)
                void update({ page: { translateTo: translateDraft.trim() } });
              setTranslateDraft(null);
            }}
          />
          <p className="mt-1 text-[11px] text-muted">Empty = your browser’s language.</p>
        </div>
      </Card>
      <RagCard />
    </>
  );
}
