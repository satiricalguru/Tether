import { isAbortError } from '@/lib/errors';
import type { AgentPrefs } from '@/lib/settings';
import { agentTurnPrompt } from '@/prompting/system';
import { decide, downgrade, selectTier, type CompleteFn, type ModelRef } from './harness';
import { argsInline, progressLog, renderObservation } from './observation';
import { executeTool, type AgentContext } from './tools/execute';
import { redactForTrace, type TraceSink } from './trace';
import type { ToolSpec, ToolTier } from './types';

/**
 * observe → decide → validate → execute, until done, askUser, a budget, or
 * stop. Phase 5 adds loop detection, a critique pass and action tiers.
 */

export interface StepEvent {
  n: number;
  thought?: string;
  action?: string;
  args?: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'invalid' | 'blocked';
  summary: string;
  url: string;
  repaired?: boolean;
}

export type AgentEvent =
  | { type: 'tier'; tier: ToolTier; reason: string }
  | { type: 'thinking'; n: number }
  | { type: 'step'; step: StepEvent };

export type RunStatus = 'done' | 'needs-user' | 'failed' | 'stopped';

export interface RunResult {
  runId: string;
  status: RunStatus;
  summary: string;
  result?: unknown;
  steps: number;
  tier: ToolTier;
}

export interface RunInput {
  runId: string;
  task: string;
  model: ModelRef;
  tools: ToolSpec[];
  prefs: AgentPrefs;
  ctx: AgentContext;
  complete: CompleteFn;
  trace: TraceSink;
  emit: (e: AgentEvent) => void;
  /** Tokens for page text in each observation. */
  contentBudget?: number;
  now?: () => number;
}

const NAVIGATING = new Set(['navigate', 'newTab', 'back', 'switchTab']);
const DIGEST_CHARS = 240;

/**
 * The gist of a page for the progress log: its opening text with the title
 * and blank lines removed. Earlier pages aren't shown to the model again, so
 * this is how it remembers what it saw (e.g. a product's price and stock).
 */
export function pageDigest(text: string, title: string, max = DIGEST_CHARS): string {
  const t = title.trim().toLowerCase();
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*|\*\*/g, '').trim())
    .filter((l) => l && l.toLowerCase() !== t && !t.startsWith(l.toLowerCase()));
  const flat = lines.join(' · ').replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max).replace(/\s+\S*$/, '')}…` : flat;
}

interface Observed {
  text: string;
  url: string;
  /** Present when the page could be read. */
  digest?: string;
}

async function observe(ctx: AgentContext, budget: number): Promise<Observed> {
  const tabs = await ctx.tabs.list(ctx.windowId);
  const cur = tabs.find((t) => t.id === ctx.tabId);
  const tabList = tabs.map((t) => ({ title: t.title, url: t.url, current: t.id === ctx.tabId }));
  try {
    const page = await ctx.readPage(ctx.tabId);
    return {
      text: renderObservation({ page, tabs: tabList, contentBudget: budget }),
      url: page.url,
      digest: pageDigest(page.text, page.title),
    };
  } catch (err) {
    const url = cur?.url ?? '';
    return {
      text: renderObservation({
        page: { error: (err as Error).message, url, title: cur?.title ?? '' },
        tabs: tabList,
        contentBudget: budget,
      }),
      url,
    };
  }
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { ctx, prefs, emit, model } = input;
  const now = input.now ?? (() => Date.now());
  const started = now();
  const deadline = started + prefs.maxMinutes * 60_000;
  const budget = input.contentBudget ?? 2500;
  let tier = selectTier(model.caps, prefs.toolTier);
  emit({
    type: 'tier',
    tier,
    reason: prefs.toolTier === 'auto' ? `chosen for ${model.model}` : 'set in settings',
  });

  const log: string[] = [];
  let pendingDigest = false;
  let failures = 0;
  let n = 0;
  const result = (
    status: RunStatus,
    summary: string,
    extra: { result?: unknown } = {},
  ): RunResult => ({
    runId: input.runId,
    status,
    summary,
    steps: n,
    tier,
    ...extra,
  });

  try {
    while (n < prefs.maxSteps) {
      if (ctx.signal.aborted) return result('stopped', 'Stopped.');
      if (now() > deadline) return result('failed', `Ran out of time (${prefs.maxMinutes} min).`);
      n += 1;
      emit({ type: 'thinking', n });
      const obs = await observe(ctx, budget);
      // The page the previous step moved to: remember its gist on that step's line.
      if (pendingDigest && obs.digest && log.length > 0) {
        const last = log.length - 1;
        log[last] = `${log[last] ?? ''} — ${obs.digest}`;
      }
      pendingDigest = false;
      const turn = [
        { role: 'user' as const, content: agentTurnPrompt(input.task, progressLog(log), obs.text) },
      ];

      let decision;
      try {
        decision = await decide({
          tier,
          model,
          tools: input.tools,
          turn,
          complete: input.complete,
          signal: ctx.signal,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        const lower = code === 'E_TOOLS_UNSUPPORTED' ? downgrade(tier, model.caps) : null;
        if (lower) {
          tier = lower;
          emit({ type: 'tier', tier, reason: 'the model rejected native tool calls' });
          n -= 1;
          continue;
        }
        throw err;
      }

      const d = decision.result;
      if (!d.ok) {
        failures += 1;
        const step: StepEvent = { n, outcome: 'invalid', summary: d.error, url: obs.url };
        emit({ type: 'step', step });
        log.push(`Step ${n}: (unusable reply: ${d.error})`);
        await input.trace.write({
          runId: input.runId,
          step: n,
          url: obs.url,
          action: '(invalid)',
          args: { raw: decision.raw },
          outcome: 'error',
          note: d.error,
        });
        if (failures >= prefs.maxConsecutiveFailures) {
          return result(
            'failed',
            `The model couldn’t produce a usable action ${failures} times in a row. Last problem: ${d.error}`,
          );
        }
        continue;
      }

      const call = d.call;
      let outcome;
      try {
        outcome = await executeTool(call, ctx);
      } catch (err) {
        if (isAbortError(err)) throw err;
        outcome = { ok: false, summary: (err as Error).message };
      }
      const blocked = outcome.summary.startsWith('blocked:');
      const step: StepEvent = {
        n,
        action: call.name,
        args: call.args,
        outcome: outcome.ok ? 'ok' : blocked ? 'blocked' : 'error',
        summary: outcome.summary,
        url: obs.url,
        ...(call.thought ? { thought: call.thought } : {}),
        ...(decision.repaired ? { repaired: true } : {}),
      };
      emit({ type: 'step', step });
      await input.trace.write({
        runId: input.runId,
        step: n,
        url: obs.url,
        action: call.name,
        args: redactForTrace(call.args),
        outcome: outcome.ok ? 'ok' : blocked ? 'blocked' : 'error',
        note: outcome.summary,
      });
      const data =
        outcome.data === undefined ? '' : ` ${JSON.stringify(outcome.data).slice(0, 600)}`;
      // The model's own visible note (never hidden reasoning) is part of its memory.
      const noted =
        call.thought && call.thoughtSource === 'output'
          ? ` [noted: ${call.thought.replace(/\s+/g, ' ').slice(0, 160)}]`
          : '';
      log.push(
        `Step ${n}: ${call.name}(${argsInline(call.args)}) → ${outcome.summary}${data}${noted}`,
      );
      pendingDigest = outcome.ok && NAVIGATING.has(call.name);

      if (outcome.end) {
        return result(
          outcome.end.status,
          outcome.end.summary,
          outcome.end.result === undefined ? {} : { result: outcome.end.result },
        );
      }
      failures = outcome.ok ? 0 : failures + 1;
      if (failures >= prefs.maxConsecutiveFailures) {
        return result('failed', `${failures} actions in a row failed. Last: ${outcome.summary}`);
      }
    }
    return result('failed', `Reached the step limit (${prefs.maxSteps}) without finishing.`);
  } catch (err) {
    if (isAbortError(err) || ctx.signal.aborted) return result('stopped', 'Stopped.');
    return result('failed', (err as Error).message);
  }
}
