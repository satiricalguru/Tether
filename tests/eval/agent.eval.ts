/// <reference types="chrome" />
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../e2e/fixtures';
import { configureProviders } from '../e2e/helpers';
import { startTempOllama, type TempOllama } from '../e2e/temp-ollama';
import { TASKS, type EvalOutcome } from './tasks';

/**
 * pnpm eval — every task in every tool-calling tier against a real model.
 *
 *   TETHER_EVAL_MODEL=ornith-1.5:9b TETHER_EVAL_TIERS=native,constrained,text pnpm eval
 *
 * A failed task is a data point, not a test failure: results go to
 * tests/eval/results/<model>.json and a table is printed at the end.
 */

const MODEL = process.env.TETHER_EVAL_MODEL ?? 'ornith-1.5:9b';
const TIERS = (process.env.TETHER_EVAL_TIERS ?? 'native,constrained,text').split(',') as (
  'native' | 'constrained' | 'text'
)[];
const ONLY = process.env.TETHER_EVAL_TASKS?.split(',');

interface Row {
  tier: string;
  task: string;
  pass: boolean;
  why: string | null;
  steps: number;
  seconds: number;
  repaired: number;
  invalid: number;
}
const rows: Row[] = [];

let ollama: TempOllama | undefined;
test.beforeAll(async () => {
  ollama = await startTempOllama(MODEL);
});
test.afterAll(async () => {
  await ollama?.stop();
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
  const name = MODEL.replace(/[^\w.-]+/g, '_');
  writeFileSync(resolve(import.meta.dirname, 'results', `${name}.md`), `${md}\n`);
  writeFileSync(
    resolve(import.meta.dirname, 'results', `${name}.json`),
    JSON.stringify({ model: MODEL, rows }, null, 2),
  );
  console.log(`\n${md}\n`);
});

for (const tier of TIERS) {
  for (const t of TASKS.filter((x) => !ONLY || ONLY.includes(x.id))) {
    test(`${tier} · ${t.id}`, async ({ context, page, extensionUrl, serviceWorker, sitesUrl }) => {
      if (!ollama) throw new Error('ollama not started');
      await configureProviders(serviceWorker, [
        { instanceId: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: ollama.url },
      ]);
      await serviceWorker.evaluate(
        async ({ tier, model }) => {
          const key = 'tether:settings';
          const s = (await chrome.storage.local.get(key))[key] as Record<
            string,
            Record<string, unknown>
          >;
          await chrome.storage.local.set({
            [key]: {
              ...s,
              selection: { instanceId: 'ollama', model },
              agent: { ...s.agent, toolTier: tier, maxSteps: 12 },
            },
          });
        },
        { tier, model: MODEL },
      );
      const site = await context.newPage();
      await site.goto(`${sitesUrl}${t.start}`);
      await page.goto(extensionUrl('sidepanel.html'));
      await expect(page.getByTestId('model-picker')).toContainText(MODEL, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Agent mode' }).click();
      await page.getByLabel('Message', { exact: true }).fill(t.task);
      const started = Date.now();
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const run = page.getByTestId('agent-run');
      await expect(run).toBeVisible();
      await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 280_000 });

      const seconds = Math.round((Date.now() - started) / 1000);
      const record = await page.evaluate(async () => {
        const open = indexedDB.open('tether');
        const db = await new Promise<IDBDatabase>((res) => {
          open.onsuccess = () => res(open.result);
        });
        return new Promise<{
          content: string;
          agent: {
            status: string;
            result?: unknown;
            steps: {
              action?: string;
              outcome: string;
              repaired?: boolean;
              args?: { url?: string };
            }[];
          };
        }>((res) => {
          const req = db.transaction('messages').objectStore('messages').getAll();
          req.onsuccess = () =>
            res(
              (req.result as { agent?: unknown; createdAt: number }[])
                .filter((m) => m.agent)
                .sort((a, b) => b.createdAt - a.createdAt)[0] as never,
            );
        });
      });
      const steps = record.agent.steps;
      const outcome: EvalOutcome = {
        status: record.agent.status,
        summary: record.content,
        result: record.agent.result,
        actions: steps.map((s) => s.action ?? '(invalid)'),
        visited: steps.flatMap((s) => (s.args?.url ? [s.args.url] : [])),
      };
      const why = t.check(outcome);
      rows.push({
        tier,
        task: t.id,
        pass: why === null,
        why,
        steps: steps.length,
        seconds,
        repaired: steps.filter((s) => s.repaired).length,
        invalid: steps.filter((s) => s.outcome === 'invalid').length,
      });
      test.info().annotations.push({
        type: why === null ? 'pass' : 'fail',
        description: `${outcome.actions.join(' → ')} | ${outcome.summary.slice(0, 200)}${why ? ` | ${why}` : ''}`,
      });
      console.log(
        `${tier} · ${t.id}: ${why === null ? 'PASS' : `FAIL (${why})`} — ${outcome.actions.join(' → ')} — ${outcome.summary.slice(0, 160)}`,
      );
    });
  }
}
