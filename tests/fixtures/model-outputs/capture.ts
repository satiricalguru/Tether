/**
 * Capture real tier-3 outputs from a local model for the parser corpus.
 *
 *   node --experimental-strip-types tests/fixtures/model-outputs/capture.ts [model] [outFile]
 *
 * Starts its own temporary `ollama serve` on 127.0.0.1:11436 (never the
 * user's main instance or its settings), runs a set of agent-style prompts
 * at several temperatures with thinking on and off, plus prompts that
 * provoke the model's native tool formats, then unloads the model and stops
 * the server. Raw outputs are written verbatim; expectations are added by
 * hand when turning them into corpus files.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { textProtocolInstructions } from '../../../src/prompting/tools-fallback.ts';
import { CORPUS_TOOLS } from './tools.ts';

const MODEL = process.argv[2] ?? 'ornith-1.5:9b';
const OUT = process.argv[3] ?? 'captured-raw.json';
const HOST = '127.0.0.1:11436';
const BASE = `http://${HOST}`;

const SNAPSHOT = `URL: https://shop.example.com/
TITLE: Example Shop — Home
TABS: [0*] Example Shop — Home  [1] Inbox

ELEMENTS:
[1] <textbox> "Search products" value=""
[2] <button> "Search"
[3] <link> "Laptops"
[4] <link> "Phones"
[5] <checkbox> "In stock only" unchecked
[6] <combobox> "Sort by" value="Relevance"
[7] <link> "Dell XPS 13 — $899"
[8] <link> "MacBook Air M3 — $1,099"

CONTENT: Welcome to Example Shop. Free shipping over $50.`;

const TASKS = [
  'Search the shop for "gaming laptop".',
  'Only show items that are in stock.',
  'Sort the results by price, lowest first.',
  'Open https://shop.example.com/deals in a new tab.',
  'I already found the answer: the cheapest laptop is the Dell XPS 13 at $899. Finish the task and report it.',
  'Get the name and price of every product on this page as structured data.',
  'Buy something nice for my mother.',
];

const SYSTEM = `You are Tether, a browser agent. You control the user's browser one action at a time to complete their task. Pick the single best next action.

${textProtocolInstructions(CORPUS_TOOLS)}`;

const TOOLS_AS_JSON = JSON.stringify(
  CORPUS_TOOLS.slice(0, 8).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  })),
);

const LEAK_SYSTEM = `You are a helpful assistant with access to these functions:\n${TOOLS_AS_JSON}\n\nWhen you want to use a function, call it.`;

interface Shot {
  id: string;
  system: string;
  user: string;
  temperature: number;
  think: boolean;
}

const shots: Shot[] = [];
const configs: [number, boolean][] = [
  [0, false],
  [0.7, true],
  [1.1, false],
];
TASKS.forEach((task, i) => {
  for (const [temperature, think] of configs) {
    shots.push({
      id: `t${i}-temp${temperature}-${think ? 'think' : 'nothink'}`,
      system: SYSTEM,
      user: `${SNAPSHOT}\n\nTASK: ${task}`,
      temperature,
      think,
    });
  }
});
for (const [i, task] of TASKS.slice(0, 4).entries()) {
  shots.push({
    id: `leak${i}`,
    system: LEAK_SYSTEM,
    user: `${SNAPSHOT}\n\n${task}`,
    temperature: 0.7,
    think: false,
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${BASE}/api/version`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('temporary ollama did not start');
}

const server = spawn('ollama', ['serve'], {
  env: { ...process.env, OLLAMA_HOST: HOST },
  stdio: 'ignore',
});
const results: {
  id: string;
  temperature: number;
  think: boolean;
  system: 'protocol' | 'leak';
  raw: string;
  thinking?: string;
}[] = [];
try {
  await waitUp();
  for (const s of shots) {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: s.think,
        messages: [
          { role: 'system', content: s.system },
          { role: 'user', content: s.user },
        ],
        options: { temperature: s.temperature, num_predict: 300, seed: 11 },
      }),
    });
    const body = (await res.json()) as {
      message?: { content?: string; thinking?: string };
      error?: string;
    };
    const raw = body.message?.content ?? `ERROR: ${body.error ?? res.status}`;
    results.push({
      id: s.id,
      temperature: s.temperature,
      think: s.think,
      system: s.system === SYSTEM ? 'protocol' : 'leak',
      raw,
      ...(body.message?.thinking ? { thinking: body.message.thinking } : {}),
    });
    process.stdout.write(`${s.id}: ${raw.slice(0, 80).replace(/\n/g, '⏎')}\n`);
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
} finally {
  await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
  }).catch(() => undefined);
  server.kill('SIGTERM');
}
