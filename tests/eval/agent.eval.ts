/// <reference types="chrome" />
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../e2e/fixtures';
import { configureProviders } from '../e2e/helpers';
import { startTempOllama, type TempOllama } from '../e2e/temp-ollama';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { TASKS, type EvalOutcome } from './tasks';
import { INTERACTIVE_TASKS, type InteractiveOutcome } from './tasks-interactive';

/**
 * pnpm eval — every task in every tool-calling tier against a real model.
 *
 *   TETHER_EVAL_MODEL=ornith-1.5:9b TETHER_EVAL_TIERS=native,constrained,text pnpm eval
 *
 * TETHER_EVAL_SUITE=basic|interactive limits the run to the Phase 4 or Phase 5 tasks.
 *
 * A failed task is a data point, not a test failure: results go to
 * tests/eval/results/<model>.json and a table is printed at the end.
 */

const MODEL = process.env.TETHER_EVAL_MODEL ?? 'ornith-1.5:9b';
const TIERS = (process.env.TETHER_EVAL_TIERS ?? 'native,constrained,text').split(',') as (
  'native' | 'constrained' | 'text'
)[];
const ONLY = process.env.TETHER_EVAL_TASKS?.split(',');
/** The agent's own time limit per task; the test waits a little longer (see playwright.eval.config.ts). */
const RUN_MINUTES = 6;
const RUN_MS = RUN_MINUTES * 60_000 + 20_000;

interface Row {
  tier: string;
  task: string;
  pass: boolean;
  why: string | null;
  steps: number;
  seconds: number;
  repaired: number;
  invalid: number;
  /** Each step as `action outcome: what the agent was told`, for diagnosing failures. */
  trace?: string[];
}
/**
 * Rows are appended to a file as each run finishes. Playwright restarts the
 * worker after a timeout, which would wipe anything kept in memory.
 */
// TETHER_EVAL_SUITE=interactive runs only the Phase 5 tasks (results in <model>.interactive.*).
const SUITE = process.env.TETHER_EVAL_SUITE;
const NAME = `${MODEL.replace(/[^\w.-]+/g, '_')}${SUITE ? `.${SUITE}` : ''}`;
const ROWS_FILE = resolve(import.meta.dirname, 'results', `${NAME}.jsonl`);
const readRows = (): Row[] =>
  existsSync(ROWS_FILE)
    ? readFileSync(ROWS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Row)
    : [];
const addRow = (r: Row) => {
  appendFileSync(ROWS_FILE, `${JSON.stringify(r)}\n`);
};
// Playwright loads this file once in the main process (to collect tests,
// TEST_WORKER_INDEX unset) and again in each worker. Start a fresh results
// file only in the former; TETHER_EVAL_FRESH=0 appends to a previous run.
if (process.env.TETHER_EVAL_FRESH !== '0' && process.env.TEST_WORKER_INDEX === undefined) {
  writeFileSync(ROWS_FILE, '');
}

let ollama: TempOllama | undefined;
test.beforeAll(async () => {
  ollama = await startTempOllama(MODEL);
});
test.afterAll(async () => {
  await ollama?.stop();
  const rows = latestRows();
  const tasks = [...new Set(rows.map((r) => r.task))];
  const lines = [
    `Model: ${MODEL}`,
    '',
    `| Task | ${TIERS.join(' | ')} |`,
    `|---|${TIERS.map(() => '---').join('|')}|`,
    ...tasks.map(
      (t) =>
        `| ${t} | ${TIERS.map((tier) => {
          const r = rows.find((x) => x.task === t && x.tier === tier);
          return r
            ? `${r.pass ? '✅' : '❌'} ${r.steps} steps, ${r.seconds}s${r.repaired ? `, ${r.repaired} repaired` : ''}`
            : '—';
        }).join(' | ')} |`,
    ),
    `| **pass rate** | ${TIERS.map((tier) => {
      const rs = rows.filter((r) => r.tier === tier);
      return rs.length ? `**${rs.filter((r) => r.pass).length}/${rs.length}**` : '—';
    }).join(' | ')} |`,
    '',
    ...rows.filter((r) => !r.pass).map((r) => `- ${r.tier} / ${r.task}: ${r.why ?? ''}`),
  ];
  const md = lines.join('\n');
  const name = NAME;
  writeFileSync(resolve(import.meta.dirname, 'results', `${name}.md`), `${md}\n`);
  writeFileSync(
    resolve(import.meta.dirname, 'results', `${name}.json`),
    JSON.stringify({ model: MODEL, rows }, null, 2),
  );
  console.log(`\n${md}\n`);
});

/** The last result per tier/task (reruns of one task replace earlier rows). */
function latestRows(): Row[] {
  const byKey = new Map<string, Row>();
  for (const r of readRows()) byKey.set(`${r.tier}/${r.task}`, r);
  return [...byKey.values()];
}

interface AgentRecord {
  content: string;
  agent: {
    status: string;
    result?: unknown;
    steps: {
      action?: string;
      outcome: string;
      summary?: string;
      repaired?: boolean;
      args?: Record<string, unknown> & { url?: string };
    }[];
  };
}

/** The newest assistant message that carries an agent run, read from IndexedDB. */
function latestAgentRecord(page: Page): Promise<AgentRecord> {
  return page.evaluate(async () => {
    const open = indexedDB.open('tether');
    const db = await new Promise<IDBDatabase>((res) => {
      open.onsuccess = () => res(open.result);
    });
    return new Promise<never>((res) => {
      const req = db.transaction('messages').objectStore('messages').getAll();
      req.onsuccess = () =>
        res(
          (req.result as { agent?: unknown; createdAt: number }[])
            .filter((m) => m.agent)
            .sort((a, b) => b.createdAt - a.createdAt)[0] as never,
        );
    });
  });
}

const traceOf = (steps: AgentRecord['agent']['steps']) =>
  steps.map(
    (s) =>
      `${s.action ?? '(invalid)'}${s.args ? ` ${JSON.stringify(s.args).slice(0, 120)}` : ''} ${s.outcome}: ${(s.summary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
  );

interface RunFixtures {
  context: BrowserContext;
  page: Page;
  extensionUrl: (path: string) => string;
  serviceWorker: Worker;
  sitesUrl: string;
}

/** Point Tether at the temp Ollama, open the start page and send the task in Agent mode. */
async function startRun(f: RunFixtures, tier: string, start: string, task: string) {
  if (!ollama) throw new Error('ollama not started');
  await configureProviders(f.serviceWorker, [
    { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: ollama.url },
  ]);
  await f.serviceWorker.evaluate(
    async ({ tier, model, minutes }) => {
      const key = 'tether:settings';
      const s = (await chrome.storage.local.get(key))[key] as Record<
        string,
        Record<string, unknown>
      >;
      await chrome.storage.local.set({
        [key]: {
          ...s,
          selection: { instanceId: 'ollama', model },
          // The run ends on its own budget before the test's timeout.
          agent: { ...s.agent, toolTier: tier, maxSteps: 15, maxMinutes: minutes },
        },
      });
    },
    { tier, model: MODEL, minutes: RUN_MINUTES },
  );
  const site = await f.context.newPage();
  await site.goto(`${f.sitesUrl}${start}`);
  await f.page.goto(f.extensionUrl('sidepanel.html'));
  await expect(f.page.getByTestId('model-picker')).toContainText(MODEL, { timeout: 30_000 });
  await f.page.getByRole('button', { name: 'Agent mode' }).click();
  await f.page.getByLabel('Message', { exact: true }).fill(task);
  const started = Date.now();
  await f.page.getByRole('button', { name: 'Send', exact: true }).click();
  return { site, started };
}

for (const tier of TIERS) {
  for (const t of TASKS.filter((x) => SUITE !== 'interactive' && (!ONLY || ONLY.includes(x.id)))) {
    test(`${tier} · ${t.id}`, async ({ context, page, extensionUrl, serviceWorker, sitesUrl }) => {
      const { started } = await startRun(
        { context, page, extensionUrl, serviceWorker, sitesUrl },
        tier,
        t.start,
        t.task,
      );
      const run = page.getByTestId('agent-run');
      await expect(run).toBeVisible();
      // The agent's own time budget ends the run before the test timeout.
      await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: RUN_MS });

      const seconds = Math.round((Date.now() - started) / 1000);
      const record = await latestAgentRecord(page);
      const steps = record.agent.steps;
      const outcome: EvalOutcome = {
        status: record.agent.status,
        summary: record.content,
        result: record.agent.result,
        actions: steps.map((s) => s.action ?? '(invalid)'),
        visited: steps.flatMap((s) => (s.args?.url ? [s.args.url] : [])),
      };
      const why = t.check(outcome);
      addRow({
        tier,
        task: t.id,
        pass: why === null,
        why,
        steps: steps.length,
        seconds,
        repaired: steps.filter((s) => s.repaired).length,
        invalid: steps.filter((s) => s.outcome === 'invalid').length,
        trace: traceOf(steps),
      });
      test.info().annotations.push({
        type: why === null ? 'pass' : 'fail',
        description: `${outcome.actions.join(' → ')} | ${outcome.summary.replace(/\s+/g, ' ').slice(0, 600)}${why ? ` | ${why}` : ''}`,
      });
      console.log(
        `${tier} · ${t.id}: ${why === null ? 'PASS' : `FAIL (${why})`} — ${outcome.actions.join(' → ')} — ${outcome.summary.replace(/\s+/g, ' ').slice(0, 600)}`,
      );
    });
  }
}

/**
 * Interactive tasks (Phase 5): the harness answers each irreversible-action
 * confirmation the way the task says, by clicking the real panel buttons,
 * then reads the app's final state from the agent's tab.
 */
for (const tier of TIERS) {
  for (const t of INTERACTIVE_TASKS.filter(
    (x) => SUITE !== 'basic' && (!ONLY || ONLY.includes(x.id)),
  )) {
    test(`${tier} · ${t.id}`, async ({ context, page, extensionUrl, serviceWorker, sitesUrl }) => {
      const { site, started } = await startRun(
        { context, page, extensionUrl, serviceWorker, sitesUrl },
        tier,
        t.start,
        t.task,
      );
      const run = page.getByTestId('agent-run');
      await expect(run).toBeVisible();
      const confirmations: InteractiveOutcome['confirmations'] = [];
      const card = page.getByTestId('agent-confirm');
      while ((await run.getAttribute('data-status')) === 'running') {
        if (Date.now() - started > RUN_MS) break;
        if (await card.isVisible()) {
          const name = (await card.innerText()).replace(/\s+/g, ' ');
          const approved =
            t.confirm instanceof RegExp ? !t.confirm.test(name) : t.confirm === 'approve';
          await card.getByRole('button', { name: approved ? 'Allow once' : 'Don’t allow' }).click();
          confirmations.push({ name, approved });
          await expect(card)
            .toBeHidden({ timeout: 10_000 })
            .catch(() => undefined);
        }
        await page.waitForTimeout(250);
      }
      await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });

      const seconds = Math.round((Date.now() - started) / 1000);
      const record = await latestAgentRecord(page);
      const steps = record.agent.steps;
      // The agent may have opened a tab of its own; use the newest fixture tab.
      const tab =
        context
          .pages()
          .filter((p) => p.url().startsWith(sitesUrl))
          .at(-1) ?? site;
      const state = await tab
        .evaluate(() => {
          const storage: Record<string, string> = {};
          for (const s of [localStorage, sessionStorage]) {
            for (let i = 0; i < s.length; i++) {
              const k = s.key(i);
              if (k !== null) storage[k] = s.getItem(k) ?? '';
            }
          }
          return { url: location.href, text: document.body.innerText.slice(0, 20_000), storage };
        })
        .catch(() => ({ url: tab.url(), text: '', storage: {} }));
      const outcome: InteractiveOutcome = {
        status: record.agent.status,
        summary: record.content,
        result: record.agent.result,
        actions: steps.map((s) => ({
          action: s.action ?? '(invalid)',
          args: s.args,
          outcome: s.outcome,
        })),
        finalUrl: state.url,
        finalText: state.text,
        storage: state.storage,
        confirmations,
      };
      const why = t.check(outcome);
      addRow({
        tier,
        task: t.id,
        pass: why === null,
        why,
        steps: steps.length,
        seconds,
        repaired: steps.filter((s) => s.repaired).length,
        invalid: steps.filter((s) => s.outcome === 'invalid').length,
        trace: traceOf(steps),
      });
      const trail = outcome.actions.map((a) => a.action).join(' → ');
      test.info().annotations.push({
        type: why === null ? 'pass' : 'fail',
        description: `${trail} | ${outcome.summary.replace(/\s+/g, ' ').slice(0, 600)}${why ? ` | ${why}` : ''}`,
      });
      console.log(
        `${tier} · ${t.id}: ${why === null ? 'PASS' : `FAIL (${why})`} — ${trail} — ${outcome.summary.replace(/\s+/g, ' ').slice(0, 600)}`,
      );
    });
  }
}
