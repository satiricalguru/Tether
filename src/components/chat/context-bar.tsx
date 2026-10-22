import { FileText, FileUp, Globe, Layers, Loader2, Lock, TextSelect, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useRef, type ComponentType } from 'react';
import { browser } from 'wxt/browser';
import {
  loadFileChip,
  loadPageChip,
  loadPdfChip,
  loadTabsChip,
  useContextDraft,
  type ChipKind,
  type ChipState,
} from '@/chat/context-store';
import type { ContextBudget } from '@/hooks/use-context-budget';
import { cn } from '@/lib/cn';
import { formatTokens } from '@/lib/format';
import { sendMessage } from '@/lib/messaging';
import { attachmentWarning } from './attachment-chips';

const LABEL: Record<ChipKind, string> = {
  page: 'This page',
  selection: 'Selection',
  tabs: 'All tabs',
  pdf: 'This PDF',
  file: 'PDF file',
};

const ICON: Record<ChipKind, ComponentType<{ className?: string }>> = {
  page: Globe,
  selection: TextSelect,
  tabs: Layers,
  pdf: FileText,
  file: FileUp,
};

const LOADERS: Record<Exclude<ChipKind, 'file'>, () => Promise<void>> = {
  page: () => loadPageChip('page'),
  selection: () => loadPageChip('selection'),
  tabs: loadTabsChip,
  pdf: loadPdfChip,
};

function chipTokens(c: ChipState): number {
  return c.attachments.reduce((n, a) => n + a.tokens, 0);
}

async function grant(origin: string | undefined, kind: Exclude<ChipKind, 'file'>) {
  const ok = await browser.permissions.request({ origins: [origin ?? '<all_urls>'] });
  if (ok) await LOADERS[kind]();
}

function Chip({
  kind,
  state,
  onToggle,
}: {
  kind: ChipKind;
  state: ChipState | undefined;
  onToggle: () => void;
}) {
  const Icon = ICON[kind];
  const active = !!state;
  const warn = state?.attachments.map(attachmentWarning).find(Boolean);
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        data-testid={`chip-${kind}`}
        data-status={state?.status ?? 'off'}
        title={
          warn ??
          state?.error?.message ??
          (state?.skipped?.length
            ? `Skipped: ${state.skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}`
            : undefined)
        }
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors',
          !active && 'border-border text-muted hover:bg-surface-2 hover:text-fg',
          state?.status === 'ready' && 'border-accent/40 bg-accent/10 text-accent',
          state?.status === 'loading' && 'border-border text-muted',
          state?.status === 'error' && 'border-danger/40 bg-danger/10 text-danger',
          warn && 'border-warn/50 bg-warn/10 text-warn',
        )}
      >
        {state?.status === 'loading' ? (
          <Loader2 className="size-3 animate-spin" />
        ) : state?.status === 'error' && state.error?.code === 'E_NO_ACCESS' ? (
          <Lock className="size-3" />
        ) : (
          <Icon className="size-3" />
        )}
        {LABEL[kind]}
        {state?.status === 'ready' && (
          <span className="tabular-nums" data-testid={`chip-${kind}-tokens`}>
            · {kind === 'tabs' ? `${state.attachments.length} · ` : ''}
            {formatTokens(chipTokens(state))}
          </span>
        )}
        {warn && <span aria-label="Possible prompt injection">⚠</span>}
        {active && <X className="size-3 opacity-60" aria-hidden />}
      </button>
    </span>
  );
}

function RagNote({ status }: { status: { enabled: boolean; model?: string } }) {
  const mode = !status.enabled ? 'off' : status.model ? 'retrieval' : 'no-model';
  return (
    <p className="text-[11px] text-muted" data-testid="rag-note" data-mode={mode}>
      {mode === 'retrieval' && (
        <>
          Too long to send whole: Tether will send the parts most relevant to your question (found
          with {status.model}).
        </>
      )}
      {mode === 'no-model' && (
        <>
          Too long to send whole, so the start will be sent. For the parts relevant to your question
          instead, install an embedding model:{' '}
          <code className="rounded bg-surface-2 px-1">ollama pull nomic-embed-text</code>
        </>
      )}
      {mode === 'off' && (
        <>
          Too long to send whole, so the start will be sent (finding relevant parts is off in
          Settings → Pages).
        </>
      )}
    </p>
  );
}

/**
 * Context chips above the composer, with the live budget. Errors explain
 * themselves and offer the permission that would fix them.
 */
export function ContextBar({
  budget,
  pdfAvailable,
  instanceId,
}: {
  budget: ContextBudget | null;
  pdfAvailable: boolean;
  /** Provider the message will go to: where retrieval looks for an embedding model. */
  instanceId?: string | undefined;
}) {
  const chips = useContextDraft((s) => s.chips);
  const set = useContextDraft((s) => s.set);
  const fileInput = useRef<HTMLInputElement>(null);

  const toggle = (kind: Exclude<ChipKind, 'file'>) => {
    if (chips[kind]) set(kind, null);
    else void LOADERS[kind]();
  };

  const blocked = Object.values(chips).find((c) => c.status === 'error');
  // Page/tab/PDF text cut to fit: say whether the relevant parts will be found or the start sent.
  const longContent = !!budget?.fitted.some(
    (a) => a.originalTokens !== undefined && a.kind !== 'selection',
  );
  const rag = useQuery({
    queryKey: ['rag', 'status', instanceId],
    queryFn: () => sendMessage('bg:rag:status', { instanceId: instanceId ?? '' }),
    enabled: longContent && !!instanceId,
    staleTime: 30_000,
  });
  const level =
    !budget || budget.attached === 0
      ? 'none'
      : budget.truncated
        ? 'over'
        : budget.fraction > 0.75
          ? 'high'
          : 'ok';

  return (
    <div className="mb-1.5 space-y-1" data-testid="context-bar">
      <div className="flex flex-wrap items-center gap-1">
        <Chip kind="page" state={chips.page} onToggle={() => toggle('page')} />
        <Chip kind="selection" state={chips.selection} onToggle={() => toggle('selection')} />
        <Chip kind="tabs" state={chips.tabs} onToggle={() => toggle('tabs')} />
        {pdfAvailable && <Chip kind="pdf" state={chips.pdf} onToggle={() => toggle('pdf')} />}
        {chips.file ? (
          <Chip kind="file" state={chips.file} onToggle={() => set('file', null)} />
        ) : (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[11px] text-muted hover:text-fg"
            onClick={() => fileInput.current?.click()}
            data-testid="chip-attach-pdf"
          >
            <FileUp className="size-3" /> Attach PDF
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          aria-label="Attach a PDF file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFileChip(f);
            e.target.value = '';
          }}
        />
        {budget && level !== 'none' && (
          <span
            className={cn(
              'ml-auto text-[11px] tabular-nums',
              level === 'ok' && 'text-muted',
              level === 'high' && 'text-warn',
              level === 'over' && 'text-danger',
            )}
            data-testid="context-budget"
            data-level={level}
            title={`Context window ${budget.window} tokens; ${budget.available} available for attachments after the reply reserve, system prompt and history.`}
          >
            {formatTokens(budget.attached)} / {formatTokens(budget.window)}
            {budget.truncated && ' · trimmed to fit'}
          </span>
        )}
      </div>
      {blocked?.error && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-[11px]"
          role="alert"
          data-testid="context-error"
        >
          <span className="text-muted">{blocked.error.message}</span>
          {blocked.error.code === 'E_NO_ACCESS' &&
            blocked.kind !== 'file' &&
            blocked.kind !== 'tabs' && (
              <>
                <button
                  type="button"
                  className="font-medium text-accent hover:underline"
                  onClick={() => void grant(blocked.error?.origin, blocked.kind as 'page')}
                >
                  Allow on this site
                </button>
                <button
                  type="button"
                  className="text-muted hover:underline"
                  onClick={() => void grant(undefined, blocked.kind as 'page')}
                >
                  Allow on all sites
                </button>
              </>
            )}
        </div>
      )}
      {longContent && rag.data && <RagNote status={rag.data} />}
      {chips.tabs?.status === 'ready' && (chips.tabs.skipped?.length ?? 0) > 0 && (
        <p className="text-[11px] text-muted" data-testid="tabs-skipped">
          {chips.tabs.skipped?.length} tab{chips.tabs.skipped?.length === 1 ? '' : 's'} skipped:{' '}
          {chips.tabs.skipped?.map((s) => `${s.title} (${s.reason})`).join(', ')}
        </p>
      )}
    </div>
  );
}
