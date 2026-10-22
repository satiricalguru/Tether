import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Loader2,
  ShieldAlert,
  Undo2,
  Wrench,
} from 'lucide-react';
import { answerConfirmation } from '@/chat/runner';
import { Button } from '@/components/ui/button';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { StepEvent } from '@/agent/loop';
import { argsInline } from '@/agent/observation';
import { cn } from '@/lib/cn';
import type { AgentRunRecord } from '@/lib/db';

const TIER_LABEL = {
  native: 'native tools',
  constrained: 'constrained JSON',
  text: 'text protocol',
} as const;

function StepRow({ step }: { step: StepEvent }) {
  const [open, setOpen] = useState(false);
  const Icon = {
    ok: Check,
    blocked: Ban,
    invalid: Wrench,
    noop: CircleSlash,
    declined: Undo2,
    error: AlertCircle,
  }[step.outcome];
  return (
    <li
      className="text-xs"
      data-testid="agent-step"
      data-outcome={step.outcome}
      data-action={step.action ?? ''}
    >
      <button
        type="button"
        className="flex w-full items-start gap-1.5 text-left"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <Icon
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            step.outcome === 'ok' && 'text-ok',
            step.outcome === 'error' && 'text-danger',
            step.outcome === 'blocked' && 'text-danger',
            step.outcome === 'invalid' && 'text-warn',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="font-mono">
            {step.action ? `${step.action}(${argsInline(step.args ?? {}, 60)})` : 'unusable reply'}
          </span>
          {step.target && <span className="text-muted"> · {step.target}</span>}
          <span className="block text-muted">{step.summary}</span>
        </span>
        {step.thought ? (
          open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : null}
      </button>
      {open && step.thought && (
        <p
          className="mt-1 ml-5 border-l-2 border-border pl-2 whitespace-pre-wrap text-muted"
          data-testid="agent-step-thought"
        >
          {step.thought}
        </p>
      )}
    </li>
  );
}

const ALL_SITES = { origins: ['<all_urls>'] };

function useAllSites(): boolean | undefined {
  const [granted, setGranted] = useState<boolean>();
  useEffect(() => {
    const read = () => void browser.permissions.contains(ALL_SITES).then(setGranted);
    read();
    browser.permissions.onAdded.addListener(read);
    browser.permissions.onRemoved.addListener(read);
    return () => {
      browser.permissions.onAdded.removeListener(read);
      browser.permissions.onRemoved.removeListener(read);
    };
  }, []);
  return granted;
}

/** Live timeline of an agent run, above its final answer. */
function ConfirmCard({ run, messageId }: { run: AgentRunRecord; messageId: string }) {
  const c = run.pendingConfirm;
  if (!c) return null;
  let host = c.url;
  try {
    host = new URL(c.url).host;
  } catch {
    // keep the raw URL
  }
  return (
    <div
      className="mt-2 rounded-md border border-warn/50 bg-warn/10 p-2 text-xs"
      role="alertdialog"
      aria-label="Confirm agent action"
      data-testid="agent-confirm"
    >
      <p className="flex items-center gap-1.5 font-medium text-fg">
        <ShieldAlert className="size-3.5 text-warn" /> The agent wants to do something that can’t be
        undone
      </p>
      <p className="mt-1 text-fg" data-testid="agent-confirm-reason">
        {c.reason}
      </p>
      {c.element && (
        <p className="mt-0.5 text-muted">
          Element: {c.element.role} “{c.element.name}”{c.element.hint ? ` — ${c.element.hint}` : ''}
        </p>
      )}
      <p className="mt-0.5 truncate text-muted" title={c.url}>
        Page: {c.title || host} · {host}
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="danger"
          onClick={() => answerConfirmation(messageId, c.id, true)}
        >
          Allow once
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => answerConfirmation(messageId, c.id, false)}
        >
          Don’t allow
        </Button>
      </div>
    </div>
  );
}

export function AgentRun({
  run,
  live,
  messageId,
}: {
  run: AgentRunRecord;
  live: boolean;
  messageId: string;
}) {
  const running = run.status === 'running';
  const allSites = useAllSites();
  const hitWall = run.steps.some((s) =>
    /permission to read|cannot read this page/i.test(s.summary),
  );
  return (
    <div
      className="rounded-lg border border-border bg-surface p-2"
      data-testid="agent-run"
      data-status={run.status}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
        <span className="font-medium text-fg">Agent</span>
        {run.tier && <span data-testid="agent-tier">· {TIER_LABEL[run.tier]}</span>}
        <span>
          · {run.steps.length} step{run.steps.length === 1 ? '' : 's'}
        </span>
        {run.status === 'needs-user' && <span className="text-warn">· needs you</span>}
        {allSites === false && (
          <button
            type="button"
            className={cn(
              'ml-auto inline-flex items-center gap-1 hover:text-fg',
              hitWall && 'font-medium text-accent',
            )}
            onClick={() => void browser.permissions.request(ALL_SITES)}
            title="Without this, the agent can only read localhost and sites you allowed"
            data-testid="agent-grant"
          >
            <ShieldCheck className="size-3" /> Allow on all sites
          </button>
        )}
      </div>
      <ol className="space-y-1.5">
        {run.steps.map((s) => (
          <StepRow key={`${s.n}-${s.action ?? 'x'}`} step={s} />
        ))}
        {running && live && !run.pendingConfirm && (
          <li className="flex items-center gap-1.5 text-xs text-muted" data-testid="agent-working">
            <Loader2 className="size-3.5 animate-spin" /> Deciding step {run.steps.length + 1}… (Esc
            to stop)
          </li>
        )}
      </ol>
      {live && <ConfirmCard run={run} messageId={messageId} />}
      {run.warnings && run.warnings.length > 0 && (
        <p
          className="mt-1 flex items-center gap-1 text-[11px] text-warn"
          data-testid="agent-warning"
        >
          <AlertTriangle className="size-3" /> {run.warnings.at(-1)}
        </p>
      )}
      {run.result !== undefined && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted">Collected data</summary>
          <pre
            className="mt-1 max-h-60 overflow-auto rounded bg-surface-2 p-2 font-mono"
            data-testid="agent-result"
          >
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
