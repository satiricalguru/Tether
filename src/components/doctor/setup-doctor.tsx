import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code-block';
import { StatusDot, type Status } from '@/components/ui/status-dot';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDiscover, useProviderStatus } from '@/hooks/use-providers';
import { useTransportCheck } from '@/hooks/use-transport-check';
import { cn } from '@/lib/cn';
import { doctorReport, type DoctorReport, type FixStep, type Severity } from '@/providers/doctor';
import type { ProviderStatus } from '@/providers/registry';

const DOT: Record<Severity, Status> = { ok: 'ok', info: 'pending', warn: 'warn', error: 'error' };
const TONE = { ok: 'ok', info: 'neutral', warn: 'warn', error: 'danger' } as const;

/**
 * `chrome-extension://<id>`. Not `new URL(...).origin`: extension schemes are
 * "non-special" in the URL spec, so outside Chrome that yields "null".
 */
export function extensionOrigin(): string {
  return browser.runtime.getURL('/').replace(/\/+$/, '');
}

function Fixes({ fixes }: { fixes: FixStep[] }) {
  const first = fixes[0];
  if (!first) return null;
  if (fixes.length === 1) {
    return (
      <div className="mt-2 space-y-1.5">
        <p className="text-xs text-muted">{first.text}</p>
        {first.code && <CodeBlock code={first.code} />}
      </div>
    );
  }
  return (
    <Tabs defaultValue={first.label} className="mt-2">
      <TabsList>
        {fixes.map((f) => (
          <TabsTrigger key={f.label} value={f.label}>
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {fixes.map((f) => (
        <TabsContent key={f.label} value={f.label} className="space-y-1.5">
          <p className="text-xs text-muted">{f.text}</p>
          {f.code && <CodeBlock code={f.code} />}
        </TabsContent>
      ))}
    </Tabs>
  );
}

async function grantOrigin(baseUrl: string): Promise<boolean> {
  return browser.permissions.request({ origins: [`${new URL(baseUrl).origin}/*`] });
}

function ProviderRow({
  status,
  report,
  onEditKey,
  onChanged,
}: {
  status: ProviderStatus;
  report: DoctorReport;
  onEditKey?: (instanceId: string) => void;
  onChanged: () => void;
}) {
  return (
    <li
      className="rounded-lg border border-border bg-surface p-3"
      data-testid={`doctor-${status.instanceId}`}
      data-diagnosis={status.health?.diagnosis ?? 'disabled'}
    >
      <div className="flex items-center gap-2">
        <StatusDot
          status={DOT[report.severity]}
          className={report.severity === 'info' ? 'animate-none' : ''}
        />
        <span className="font-medium">{status.label}</span>
        <span className="truncate font-mono text-xs text-muted">{status.baseUrl}</span>
        <Badge tone={TONE[report.severity]} className="ml-auto">
          {report.title}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted">{report.summary}</p>
      <Fixes fixes={report.fixes} />
      {report.action === 'grant-permission' && (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => void grantOrigin(status.baseUrl).then(onChanged)}
        >
          <ShieldCheck /> Allow {new URL(status.baseUrl).host}
        </Button>
      )}
      {report.action === 'edit-api-key' && onEditKey && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => onEditKey(status.instanceId)}
        >
          <KeyRound /> Set API key
        </Button>
      )}
    </li>
  );
}

/**
 * Lists every configured backend as connected / not running / blocked, with
 * the exact fix. `compact` hides quiet "not running" rows behind a summary
 * line so the one actionable problem stands out (side panel).
 */
export function SetupDoctor({
  compact = false,
  onEditKey,
}: {
  compact?: boolean;
  onEditKey?: (instanceId: string) => void;
}) {
  const status = useProviderStatus();
  const discover = useDiscover();
  const transport = useTransportCheck();
  const [showQuiet, setShowQuiet] = useState(!compact);
  const origin = useMemo(() => extensionOrigin(), []);

  const rows = (status.data ?? [])
    .filter((s) => s.enabled)
    .map((s) => ({ status: s, report: doctorReport({ ...s, extensionOrigin: origin }) }));
  const loud = rows.filter((r) => r.report.severity !== 'info');
  const quiet = rows.filter((r) => r.report.severity === 'info');
  const connected = rows.filter((r) => r.report.severity === 'ok').length;

  return (
    <section aria-labelledby="doctor-title" data-testid="setup-doctor">
      <div className="mb-2 flex items-center gap-2">
        <h2 id="doctor-title" className="text-sm font-semibold">
          Setup Doctor
        </h2>
        <span className="text-xs text-muted" data-testid="doctor-summary">
          {status.isPending
            ? 'Checking…'
            : connected
              ? `${connected} backend${connected === 1 ? '' : 's'} connected`
              : 'No local model server found'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={discover.isPending}
          onClick={() => discover.mutate()}
        >
          <RefreshCw className={cn(discover.isPending && 'animate-spin')} />
          {discover.isPending ? 'Scanning…' : 'Rescan'}
        </Button>
      </div>

      <ul className="space-y-2">
        {loud.map((r) => (
          <ProviderRow
            key={r.status.instanceId}
            {...r}
            onChanged={() => void status.refetch()}
            {...(onEditKey ? { onEditKey } : {})}
          />
        ))}
        {showQuiet &&
          quiet.map((r) => (
            <ProviderRow key={r.status.instanceId} {...r} onChanged={() => void status.refetch()} />
          ))}
      </ul>

      {!showQuiet && quiet.length > 0 && (
        <button
          type="button"
          className="mt-2 text-xs text-muted underline-offset-2 hover:underline"
          onClick={() => {
            setShowQuiet(true);
          }}
        >
          Not running: {quiet.map((r) => r.status.label).join(', ')} — show how to start
        </button>
      )}

      <p
        className="mt-3 flex items-center gap-1.5 text-xs text-muted"
        data-testid="transport-check"
      >
        <StatusDot
          status={transport === 'ok' ? 'ok' : transport === 'failed' ? 'error' : 'pending'}
        />
        Extension background worker:{' '}
        {transport === 'ok'
          ? 'streaming OK'
          : transport === 'failed'
            ? 'not responding'
            : 'checking…'}
      </p>
    </section>
  );
}
