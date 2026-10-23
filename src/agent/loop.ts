import { fence } from '@/context/attachments';
import { estimateTokens } from '@/context/tokens';
import { isAbortError } from '@/lib/errors';
import type { AgentPrefs } from '@/lib/settings';
import type { ChatMessage, ContentPart } from '@/providers/types';
import { agentTurnPrompt } from '@/prompting/system';
import { decide, downgrade, selectTier, type CompleteFn, type ModelRef } from './harness';
import { argsInline, progressLog, renderObservation } from './observation';
import { renderSnapshot } from './page/snapshot';
import type { PageSnapshot, SnapshotElement } from './page/types';
import { carriesData, classify } from './tiers';
import { ELEMENT_TOOLS } from './tools/specs';
import { executeTool, type AgentContext, type ToolOutcome } from './tools/execute';
import { redactForTrace, type TraceSink } from './trace';
import type { ToolCall, ToolSpec, ToolTier } from './types';
import type { SetOfMarksResult } from './vision/draw';
import { isImageRejection } from './vision/marks';

/**
 * observe → decide → validate → guard → (confirm) → execute → verify, until
 * done, askUser, a budget, or stop.
 */

export interface StepEvent {
  n: number;
  thought?: string;
  action?: string;
  args?: Record<string, unknown>;
  /** The element acted on, as the model saw it. */
  target?: string;
  outcome: 'ok' | 'error' | 'invalid' | 'blocked' | 'noop' | 'declined';
  summary: string;
  url: string;
  repaired?: boolean;
}

export interface ConfirmRequest {
  id: string;
  step: number;
  reason: string;
  action: string;
  args: Record<string, unknown>;
  element?: { role: string; name: string; hint?: string };
  url: string;
  title: string;
}

export type AgentEvent =
  | { type: 'tier'; tier: ToolTier; reason: string }
  | { type: 'thinking'; n: number }
  | { type: 'step'; step: StepEvent }
  | { type: 'confirm'; request: ConfirmRequest }
  | { type: 'confirmed'; id: string; approved: boolean }
  | { type: 'warning'; message: string };

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
  /** Ask the user about an irreversible action. Resolves true to proceed. */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /** Tokens for page text in each observation. */
  contentBudget?: number;
  /** Tokens for the element list (page engine). */
  elementBudget?: number;
  now?: () => number;
}

const NAVIGATING = new Set([
  'navigate',
  'newTab',
  'back',
  'forward',
  'reload',
  'switchTab',
  'closeTab',
  'click',
]);
const DIGEST_CHARS = 240;
/**
 * Split what's left of the model's window between the element list and the
 * page text. Everything else a step sends is fixed or small: the system
 * prompt and tool schemas (`fixedTokens`), the task and progress notes, and
 * room for the reply. Our token estimate runs low against real tokenizers,
 * so only 75% of the remainder is handed out.
 */
export function agentBudgets(
  window: number,
  fixedTokens: number,
): { elementBudget: number; contentBudget: number } {
  const PROGRESS_AND_TASK = 600;
  const REPLY = 512;
  const avail = Math.max(0, (window - fixedTokens - PROGRESS_AND_TASK - REPLY) * 0.75);
  return {
    elementBudget: Math.round(Math.max(300, Math.min(4000, avail * 0.6))),
    contentBudget: Math.round(Math.max(200, Math.min(2000, avail * 0.4))),
  };
}

/** A server's "prompt too long for the context window" error, in the wordings local servers use. */
export function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /exceeds? the (available )?context|context (length|size|window) (exceeded|is too small)|maximum context length|too many tokens|prompt is too long|n_ctx/i.test(
    msg,
  );
}

export const LOOP_WARN = 3;
export const LOOP_ABORT = 5;
/** Looser limits for the same action whatever the page state (it keeps changing, but not usefully). */
export const LOOP_WARN_ANY = 5;
export const LOOP_ABORT_ANY = 8;

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
  title: string;
  digest?: string;
  /** Page-engine snapshot, when available. */
  snap?: PageSnapshot;
}

async function tabList(ctx: AgentContext) {
  const tabs = await ctx.tabs.list(ctx.windowId);
  return {
    cur: tabs.find((t) => t.id === ctx.tabId),
    list: tabs.map((t) => ({ title: t.title, url: t.url, current: t.id === ctx.tabId })),
  };
}

/** Phase 5 observation: tabs + numbered elements + readable text, all fenced as page data. */
/**
 * The part of the page text that matches the scroll position, so content
 * the agent scrolled to (or that loaded at the bottom) is what it reads.
 */
export function textWindow(text: string, scroll: PageSnapshot['scroll'], chars: number): string {
  if (text.length <= chars) return text;
  const range = scroll.height - scroll.viewport;
  const at = range > 0 ? Math.min(1, Math.max(0, scroll.y / range)) : 0;
  const start = Math.round(at * (text.length - chars));
  const end = start + chars;
  return [
    start > 0 ? `(… ${start} characters above not shown; scroll up to read them)` : '',
    text.slice(start, end),
    end < text.length ? `(… ${text.length - end} characters below; scroll down to read them)` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Words that tell the model how to read the marks: ids, never pixels. */
export const VISION_NOTE =
  'The screenshot shows the visible part of the page. Each element from ELEMENTS has a red box labelled with its id. Answer with ids, never with coordinates.';

/** The user turn: text alone, or text plus this step's screenshot. */
export function turnContent(prompt: string, shot?: SetOfMarksResult): string | ContentPart[] {
  if (!shot) return prompt;
  return [
    { type: 'text', text: `${prompt}\n\n${VISION_NOTE}` },
    { type: 'image', data: shot.image, mimeType: 'image/jpeg' },
  ];
}

export function renderAgentView(
  snap: PageSnapshot,
  tabs: { title: string; url: string; current: boolean }[],
  textBudget: number,
): string {
  const t = tabs
    .map((x, i) => `[${i}${x.current ? '*' : ''}] ${x.title.slice(0, 60) || x.url}`)
    .join('  ');
  const text = textWindow(snap.text.trim(), snap.scroll, textBudget * 4);
  const body = `ELEMENTS:\n${renderSnapshot(snap)}${text ? `\n\nPAGE TEXT:\n${text}` : ''}`;
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    `TABS: ${t}`,
    fence({
      id: 'obs',
      kind: 'page',
      title: snap.title,
      url: snap.url,
      text: body,
      tokens: estimateTokens(body),
      warnings: [],
    }),
  ].join('\n');
}

async function observe(ctx: AgentContext, input: RunInput, lastId?: string): Promise<Observed> {
  const { cur, list } = await tabList(ctx);
  const budget = input.contentBudget ?? 2500;
  try {
    if (ctx.page) {
      const snap = await ctx.page.snapshot(ctx.tabId, {
        task: input.task,
        ...(lastId ? { lastId } : {}),
        maxTokens: input.elementBudget ?? 4000,
      });
      return {
        text: renderAgentView(snap, list, budget),
        url: snap.url,
        title: snap.title,
        digest: pageDigest(snap.text, snap.title),
        snap,
      };
    }
    const page = await ctx.readPage(ctx.tabId);
    return {
      text: renderObservation({ page, tabs: list, contentBudget: budget }),
      url: page.url,
      title: page.title,
      digest: pageDigest(page.text, page.title),
    };
  } catch (err) {
    const url = cur?.url ?? '';
    return {
      text: renderObservation({
        page: { error: (err as Error).message, url, title: cur?.title ?? '' },
        tabs: list,
        contentBudget: budget,
      }),
      url,
      title: cur?.title ?? '',
    };
  }
}

function targetOf(call: ToolCall, snap?: PageSnapshot): SnapshotElement | undefined {
  const id = call.args.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !snap) return undefined;
  return snap.elements.find((e) => e.id === String(id));
}

function describeTarget(el: SnapshotElement | undefined): string | undefined {
  return el ? `${el.role} "${el.name || el.id}"` : undefined;
}

/** Ask the model to check its own claim against the final page (spec §6.4 critique). */
async function critique(
  input: RunInput,
  obsText: string,
  summary: string,
): Promise<{ complete: boolean; reason: string }> {
  try {
    const c = await input.complete(
      {
        instanceId: input.model.instanceId,
        model: input.model.model,
        messages: [
          {
            role: 'system',
            content:
              'You check whether a browsing agent really finished its task. Look at the task, the agent’s final answer and the current page. Reply with JSON {"complete": true|false, "reason": "..."}. Say false only if something the task asked for clearly was not done or the answer contradicts the page.',
          },
          {
            role: 'user',
            content: `TASK: ${input.task}\n\nAGENT'S ANSWER: ${summary}\n\nCURRENT PAGE:\n${obsText}`,
          },
        ],
        responseFormat: {
          type: 'json_schema',
          name: 'critique',
          schema: {
            type: 'object',
            properties: { complete: { type: 'boolean' }, reason: { type: 'string' } },
            required: ['complete', 'reason'],
          },
        },
        options: { temperature: 0, maxTokens: 200 },
        ...(input.model.caps.thinking ? { think: false } : {}),
      },
      input.ctx.signal,
    );
    const m = /\{[\s\S]*\}/.exec(c.text);
    const parsed = m ? (JSON.parse(m[0]) as { complete?: unknown; reason?: unknown }) : {};
    return {
      complete: parsed.complete !== false,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    // A critique that can't run never blocks finishing.
    return { complete: true, reason: '' };
  }
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { ctx, prefs, emit, model } = input;
  const now = input.now ?? (() => Date.now());
  let deadline = now() + prefs.maxMinutes * 60_000;
  let tier = selectTier(model.caps, prefs.toolTier);
  emit({
    type: 'tier',
    tier,
    reason: prefs.toolTier === 'auto' ? `chosen for ${model.model}` : 'set in settings',
  });

  const log: string[] = [];
  const seen: { host: string; text: string }[] = [{ host: '', text: input.task }];
  const repeats = new Map<string, number>();
  // Actions the user declined this run: a repeat is refused without asking again.
  const declined = new Set<string>();
  let warning = '';
  let pendingDigest = false;
  let failures = 0;
  let critiqued = false;
  let n = 0;
  let lastId: string | undefined;
  let cached: Observed | undefined;
  let vision = !!ctx.vision;
  let captureWarned = false;
  // Page budgets for this run; shrunk if the server says a step didn't fit.
  const budgets = { contentBudget: input.contentBudget, elementBudget: input.elementBudget };
  let shrinks = 0;
  const view = () => ({ ...input, ...budgets });
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
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };

  try {
    while (n < prefs.maxSteps) {
      if (ctx.signal.aborted) return result('stopped', 'Stopped.');
      if (now() > deadline) return result('failed', `Ran out of time (${prefs.maxMinutes} min).`);
      n += 1;
      emit({ type: 'thinking', n });
      const obs = cached ?? (await observe(ctx, view(), lastId));
      cached = undefined;
      if (pendingDigest && obs.digest && log.length > 0) {
        const last = log.length - 1;
        log[last] = `${log[last] ?? ''} — ${obs.digest}`;
      }
      pendingDigest = false;
      if (obs.snap) {
        seen.push({ host: hostOf(obs.url), text: obs.snap.text.slice(0, 3000) });
        if (seen.length > 8) seen.splice(1, 1);
      }

      // Bot checks are the user's to solve (spec §11: no CAPTCHA solving).
      if (obs.snap?.captcha) {
        return result(
          'needs-user',
          'This page is asking to verify you’re human. Please complete the check in the tab, then ask me to continue.',
        );
      }

      const prompt =
        agentTurnPrompt(input.task, progressLog(log), obs.text) +
        (warning ? `\n\nWARNING: ${warning}` : '');
      warning = '';
      // Vision tier: this step's screenshot only; earlier turns are never resent.
      let shot: SetOfMarksResult | undefined;
      if (vision && ctx.vision && obs.snap) {
        try {
          shot = await ctx.vision.capture(ctx.tabId, obs.snap);
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (!captureWarned) {
            captureWarned = true;
            emit({
              type: 'warning',
              message: `Couldn’t take a screenshot (${(err as Error).message}). Continuing with the page text.`,
            });
          }
        }
      }
      const turn: ChatMessage[] = [{ role: 'user', content: turnContent(prompt, shot) }];

      let decision;
      try {
        decision = await decide({
          tier,
          model,
          tools: input.tools,
          turn,
          complete: input.complete,
          // The time limit holds during a slow model call too, not only between steps.
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, deadline - now()))]),
          check: (call) => {
            const wantsId =
              ELEMENT_TOOLS.has(call.name) ||
              ((call.name === 'pressKey' || call.name === 'scroll') && call.args.id !== undefined);
            if (wantsId && obs.snap && !targetOf(call, obs.snap)) {
              return `Element [${String(call.args.id)}] is not in the ELEMENTS list. Use an id shown in the current ELEMENTS.`;
            }
            return null;
          },
        });
      } catch (err) {
        // A model or server that won't take images: drop them for the rest of the run.
        if (shot && !isAbortError(err) && isImageRejection(err)) {
          vision = false;
          emit({
            type: 'warning',
            message: 'The model didn’t accept screenshots; continuing with the page text only.',
          });
          n -= 1;
          cached = obs;
          continue;
        }
        const code = (err as { code?: string }).code;
        const lower = code === 'E_TOOLS_UNSUPPORTED' ? downgrade(tier, model.caps) : null;
        if (lower) {
          tier = lower;
          emit({ type: 'tier', tier, reason: 'the model rejected native tool calls' });
          n -= 1;
          cached = obs;
          continue;
        }
        // Our token estimate is only an estimate: if the step didn't fit the
        // window, send less of the page and try the step again (twice at most).
        if (shrinks < 2 && isContextOverflow(err)) {
          shrinks += 1;
          budgets.contentBudget = Math.max(150, Math.round((budgets.contentBudget ?? 2500) * 0.6));
          budgets.elementBudget = Math.max(250, Math.round((budgets.elementBudget ?? 4000) * 0.6));
          emit({
            type: 'warning',
            message: 'The page didn’t fit the model’s context window; sending less of it.',
          });
          n -= 1;
          cached = undefined;
          continue;
        }
        throw err;
      }

      const d = decision.result;
      if (!d.ok) {
        failures += 1;
        emit({ type: 'step', step: { n, outcome: 'invalid', summary: d.error, url: obs.url } });
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
        cached = obs;
        continue;
      }

      const call = d.call;
      const target = targetOf(call, obs.snap);
      const targetName = describeTarget(target);

      // Loop detection: the same action on the same thing on the same page.
      const key = `${obs.url}|${call.name}|${target ? `${target.role}:${target.name}` : JSON.stringify(call.args)}`;
      // Counted twice. In the same page state (hash and scroll position) the
      // limits are tight: five scrolls that each load more entries are
      // progress, five that change nothing aren't. Across states they're
      // looser, for pages that change on every click without getting anywhere.
      const stateKey = `${key}|${obs.snap ? `${obs.snap.hash}@${obs.snap.scroll.y}` : ''}`;
      const same = (repeats.get(stateKey) ?? 0) + 1;
      const any = (repeats.get(key) ?? 0) + 1;
      repeats.set(stateKey, same);
      repeats.set(key, any);
      const count = same >= LOOP_ABORT || any >= LOOP_ABORT_ANY ? Math.max(same, any) : 0;
      if (count > 0) {
        return result(
          'failed',
          `Stopped: the agent repeated ${call.name}${targetName ? ` on ${targetName}` : ''} ${count} times without progress.`,
        );
      }
      if (same >= LOOP_WARN || any >= LOOP_WARN_ANY) {
        warning =
          'You are repeating an action that isn’t working. Re-read the page and try a different approach.';
        emit({ type: 'warning', message: warning });
      }

      let outcome: ToolOutcome;
      let stepOutcome: StepEvent['outcome'];
      const verdict = classify(call, target);
      const exfil =
        call.name === 'navigate' || call.name === 'newTab'
          ? carriesData(
              String(call.args.url),
              hostOf(obs.url),
              seen.filter((s) => s.host !== hostOf(String(call.args.url))).map((s) => s.text),
            )
          : null;

      if (verdict.decision === 'refuse' || exfil) {
        const why = exfil ?? (verdict.decision === 'refuse' ? verdict.reason : '');
        outcome = { ok: false, summary: `blocked: ${why}` };
        stepOutcome = 'blocked';
      } else {
        let approved = true;
        if (verdict.decision === 'confirm' && declined.has(key)) {
          approved = false;
        } else if (verdict.decision === 'confirm') {
          const request: ConfirmRequest = {
            id: `${input.runId}:${n}`,
            step: n,
            reason: verdict.reason,
            action: call.name,
            args: call.args,
            ...(target
              ? {
                  element: {
                    role: target.role,
                    name: target.name,
                    ...(target.hint ? { hint: target.hint } : {}),
                  },
                }
              : {}),
            url: obs.url,
            title: obs.title,
          };
          emit({ type: 'confirm', request });
          const waitStart = now();
          // No confirmer means no human to ask: irreversible actions are refused.
          approved = input.confirm ? await input.confirm(request) : false;
          // Time spent waiting for the user doesn't count against the run.
          deadline += now() - waitStart;
          emit({ type: 'confirmed', id: request.id, approved });
          if (!approved) declined.add(key);
        }
        if (!approved) {
          outcome = {
            ok: false,
            summary: `the user declined: ${verdict.decision === 'confirm' ? verdict.reason : call.name}. Don't try this again; finish or ask the user what to do instead.`,
          };
          stepOutcome = 'declined';
        } else {
          try {
            outcome = await executeTool(call, ctx);
          } catch (err) {
            if (isAbortError(err)) throw err;
            outcome = { ok: false, summary: (err as Error).message };
          }
          stepOutcome = outcome.ok
            ? 'ok'
            : outcome.summary.startsWith('blocked:')
              ? 'blocked'
              : 'error';
        }
      }

      // Verify: did a page action change anything? (spec §6.3 no-op detection)
      let afterHash: string | undefined;
      if (
        stepOutcome === 'ok' &&
        ctx.page &&
        obs.snap &&
        !outcome.end &&
        call.name !== 'extract' &&
        call.name !== 'waitFor'
      ) {
        cached = await observe(ctx, view(), target?.id);
        afterHash = cached.snap?.hash;
        if (
          cached.url === obs.url &&
          afterHash !== undefined &&
          afterHash === obs.snap.hash &&
          ELEMENT_TOOLS.has(call.name)
        ) {
          outcome = {
            ok: false,
            summary: `That ${call.name} produced no change. Try a different element.`,
          };
          stepOutcome = 'noop';
        }
      }

      // Critique before accepting "done" (once per run).
      if (outcome.end?.status === 'done' && prefs.critique && !critiqued) {
        critiqued = true;
        const verdictC = await critique(input, obs.text, outcome.end.summary);
        if (!verdictC.complete) {
          outcome = {
            ok: false,
            summary: `not finished yet (self-check: ${verdictC.reason || 'the task isn’t complete'})`,
          };
          stepOutcome = 'error';
        }
      }

      const step: StepEvent = {
        n,
        action: call.name,
        args: call.args,
        outcome: stepOutcome,
        summary: outcome.summary,
        url: obs.url,
        ...(targetName ? { target: targetName } : {}),
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
        ...(targetName ? { elementName: targetName } : {}),
        ...(obs.snap ? { beforeHash: obs.snap.hash } : {}),
        ...(shot ? { thumbnail: shot.thumbnail } : {}),
        ...(afterHash ? { afterHash } : {}),
        outcome:
          stepOutcome === 'ok'
            ? 'ok'
            : stepOutcome === 'noop'
              ? 'noop'
              : stepOutcome === 'blocked' || stepOutcome === 'declined'
                ? 'blocked'
                : 'error',
        note: outcome.summary,
      });
      const data =
        outcome.data === undefined ? '' : ` ${JSON.stringify(outcome.data).slice(0, 600)}`;
      const noted =
        call.thought && call.thoughtSource === 'output'
          ? ` [noted: ${call.thought.replace(/\s+/g, ' ').slice(0, 160)}]`
          : '';
      const on = targetName ? ` on ${targetName}` : '';
      log.push(
        `Step ${n}: ${call.name}(${argsInline(call.args)})${on} → ${outcome.summary}${data}${noted}`,
      );
      pendingDigest = stepOutcome === 'ok' && NAVIGATING.has(call.name);
      if (target) lastId = target.id;

      if (outcome.end) {
        return result(
          outcome.end.status,
          outcome.end.summary,
          outcome.end.result === undefined ? {} : { result: outcome.end.result },
        );
      }
      // A declined confirmation is the user's decision, not the agent failing.
      failures = stepOutcome === 'ok' || stepOutcome === 'declined' ? 0 : failures + 1;
      if (failures >= prefs.maxConsecutiveFailures) {
        return result('failed', `${failures} actions in a row failed. Last: ${outcome.summary}`);
      }
    }
    return result('failed', `Reached the step limit (${prefs.maxSteps}) without finishing.`);
  } catch (err) {
    if (ctx.signal.aborted) return result('stopped', 'Stopped.');
    if (now() >= deadline) return result('failed', `Ran out of time (${prefs.maxMinutes} min).`);
    if (isAbortError(err)) return result('stopped', 'Stopped.');
    return result('failed', (err as Error).message);
  }
}
