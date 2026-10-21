import { AlertCircle, Ban, Check, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';
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
  const Icon =
    step.outcome === 'ok'
      ? Check
      : step.outcome === 'blocked'
        ? Ban
        : step.outcome === 'invalid'
          ? Wrench
          : AlertCircle;
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
export function AgentRun({ run, live }: { run: AgentRunRecord; live: boolean }) {
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
        {running && live && (
          <li className="flex items-center gap-1.5 text-xs text-muted" data-testid="agent-working">
            <Loader2 className="size-3.5 animate-spin" /> Deciding step {run.steps.length + 1}… (Esc
            to stop)
          </li>
        )}
      </ol>
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
