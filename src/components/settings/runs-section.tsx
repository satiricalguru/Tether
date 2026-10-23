import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { downloadText } from '@/chat/export';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { getDb, type TraceRecord } from '@/lib/db';

interface RunSummary {
  runId: string;
  started: number;
  steps: TraceRecord[];
}

function groupRuns(traces: TraceRecord[]): RunSummary[] {
  const byRun = new Map<string, TraceRecord[]>();
  for (const t of traces) byRun.set(t.runId, [...(byRun.get(t.runId) ?? []), t]);
  return [...byRun.entries()]
    .map(([runId, steps]) => ({
      runId,
      steps: steps.sort((a, b) => a.step - b.step || a.createdAt - b.createdAt),
      started: Math.min(...steps.map((s) => s.createdAt)),
    }))
    .sort((a, b) => b.started - a.started);
}

const OUTCOME_CLASS: Record<TraceRecord['outcome'], string> = {
  ok: 'text-ok',
  error: 'text-danger',
  blocked: 'text-danger',
  noop: 'text-warn',
};

/**
 * Every agent step, as recorded in IndexedDB: the debugging surface for
 * agent runs (spec §6.6). Arguments were redacted before they were stored.
 */
export function RunsSection() {
  const traces = useLiveQuery(() => getDb().traces.toArray(), []);
  const runs = groupRuns(traces ?? []);
  const [open, setOpen] = useState<string | null>(() =>
    location.hash.startsWith('#runs:') ? location.hash.slice(6) : null,
  );

  const exportRun = (r: RunSummary) => {
    downloadText(
      `tether-run-${r.runId.slice(0, 8)}.json`,
      JSON.stringify({ format: 'tether.trace.v1', runId: r.runId, steps: r.steps }, null, 2),
      'application/json',
    );
  };

  return (
    <Card>
      <CardTitle>Agent runs</CardTitle>
      <p className="mb-3 text-xs text-muted">
        Each step the agent took: action, element, page, outcome, and whether the page changed.
        Stored only in this browser.
      </p>
      {runs.length === 0 && <p className="text-xs text-muted">No agent runs yet.</p>}
      <ul className="divide-y divide-border" data-testid="runs">
        {runs.map((r) => {
          const last = r.steps.at(-1);
          const isOpen = open === r.runId;
          return (
            <li key={r.runId} className="py-2" data-testid="run" data-run={r.runId}>
              <div className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setOpen(isOpen ? null : r.runId);
                  }}
                >
                  {new Date(r.started).toLocaleString()} · {r.steps.length} steps · ended with{' '}
                  {last?.action ?? '—'}
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Export run as JSON"
                  onClick={() => exportRun(r)}
                >
                  <Download />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete run"
                  onClick={() => void getDb().traces.where('runId').equals(r.runId).delete()}
                >
                  <Trash2 />
                </Button>
              </div>
              {isOpen && (
                <table className="mt-2 w-full table-fixed text-[11px]" data-testid="run-steps">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="w-8">#</th>
                      <th className="w-40">Action</th>
                      <th>Result</th>
                      <th className="w-24">Changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.steps.map((s) => (
                      <tr
                        key={s.id}
                        className="border-t border-border align-top"
                        data-testid="run-step"
                      >
                        <td className="py-1">{s.step}</td>
                        <td className="py-1 font-mono break-all">
                          {s.action}
                          {s.elementName && (
                            <span className="block text-muted">{s.elementName}</span>
                          )}
                        </td>
                        <td className="py-1">
                          <span className={cn('font-medium', OUTCOME_CLASS[s.outcome])}>
                            {s.outcome}
                          </span>{' '}
                          {s.note}
                          <span className="block truncate text-muted" title={s.url}>
                            {s.url}
                          </span>
                          {s.thumbnail?.startsWith('data:image/jpeg;base64,') && (
                            <img
                              src={s.thumbnail}
                              alt={`What the model saw at step ${s.step}`}
                              className="mt-1 max-h-40 max-w-full rounded border border-border"
                              data-testid="run-step-thumbnail"
                            />
                          )}
                        </td>
                        <td className="py-1 text-muted">
                          {s.beforeHash && s.afterHash
                            ? s.beforeHash === s.afterHash
                              ? 'no'
                              : 'yes'
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
      {runs.length > 0 && (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              downloadText(
                'tether-traces.json',
                JSON.stringify({ format: 'tether.trace.v1', runs }, null, 2),
                'application/json',
              )
            }
          >
            <Download /> Export all
          </Button>
        </div>
      )}
    </Card>
  );
}
