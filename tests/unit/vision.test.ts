import { describe, expect, it } from 'vitest';
import type { Completion, ModelRef } from '@/agent/harness';
import { runAgent, turnContent, VISION_NOTE, type AgentEvent, type RunInput } from '@/agent/loop';
import type { PageSnapshot, SnapshotElement } from '@/agent/page/types';
import { classify } from '@/agent/tiers';
import { executeTool, type AgentContext, type VisionApi } from '@/agent/tools/execute';
import { COMPUTER_TOOLS, computerTools } from '@/agent/tools/specs';
import { memoryTraceSink } from '@/agent/trace';
import type { SetOfMarksResult } from '@/agent/vision/draw';
import {
  fitWithin,
  imageTokens,
  isImageRejection,
  labelPosition,
  marksFor,
} from '@/agent/vision/marks';
import type { ChatStreamRequest } from '@/background/chat';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { DEFAULT_CAPABILITIES, type ContentPart } from '@/providers/types';

const el = (
  id: string,
  rect: SnapshotElement['rect'],
  extra: Partial<SnapshotElement> = {},
): SnapshotElement => ({
  id,
  tag: 'button',
  role: 'button',
  name: `Button ${id}`,
  inViewport: true,
  rect,
  ...extra,
});

describe('set-of-marks geometry', () => {
  it('scales CSS boxes to screenshot pixels and clips them to the image', () => {
    const marks = marksFor(
      [
        el('1', { x: 10, y: 20, w: 100, h: 30 }),
        el('2', { x: 950, y: 700, w: 200, h: 200 }), // runs off the bottom-right
        el('3', { x: -50, y: 10, w: 80, h: 20 }), // starts off the left edge
      ],
      2,
      { width: 2000, height: 1600 },
    );
    expect(marks).toEqual([
      { id: '1', x: 20, y: 40, w: 200, h: 60 },
      { id: '2', x: 1900, y: 1400, w: 100, h: 200 },
      { id: '3', x: 0, y: 20, w: 60, h: 40 },
    ]);
  });

  it('leaves out elements that are off screen or too small to label', () => {
    const marks = marksFor(
      [
        el('1', { x: 0, y: 0, w: 50, h: 50 }, { inViewport: false }),
        el('2', { x: 0, y: 0, w: 1, h: 30 }),
        el('3', { x: 5000, y: 0, w: 50, h: 50 }),
        el('4', { x: 0, y: 0, w: 50, h: 50 }),
      ],
      1,
      { width: 1000, height: 800 },
    );
    expect(marks.map((m) => m.id)).toEqual(['4']);
  });

  it('downscales to the long side and never upscales', () => {
    expect(fitWithin({ width: 2560, height: 1600 }, 1024)).toEqual({ width: 1024, height: 640 });
    expect(fitWithin({ width: 900, height: 1800 }, 1024)).toEqual({ width: 512, height: 1024 });
    expect(fitWithin({ width: 800, height: 600 }, 1024)).toEqual({ width: 800, height: 600 });
  });

  it('puts a label above its box, or inside it at the top edge, and keeps it in the image', () => {
    const image = { width: 300, height: 200 };
    const label = { width: 30, height: 16 };
    expect(labelPosition({ id: '1', x: 50, y: 40, w: 60, h: 20 }, label, image)).toEqual({
      x: 50,
      y: 24,
    });
    expect(labelPosition({ id: '2', x: 50, y: 4, w: 60, h: 20 }, label, image)).toEqual({
      x: 50,
      y: 4,
    });
    expect(labelPosition({ id: '3', x: 290, y: 100, w: 10, h: 10 }, label, image).x).toBe(270);
  });

  it('estimates image tokens by area', () => {
    expect(imageTokens(1024)).toBe(800);
    expect(imageTokens(512)).toBe(200);
    expect(imageTokens(10)).toBe(imageTokens(256));
  });

  it('recognises provider errors that mean "no images here"', () => {
    for (const msg of [
      'model does not support images',
      'this model is missing data required for image input (no mmproj)',
      'Image input is not supported by this server',
      'vision is unsupported for llama3.2:3b',
    ]) {
      expect(isImageRejection(new Error(msg)), msg).toBe(true);
    }
    for (const msg of ['context length exceeded', 'connection refused', 'image saved'])
      expect(isImageRejection(new Error(msg)), msg).toBe(false);
  });
});

describe('the screenshot tool', () => {
  it('is offered only with vision on, and is a read', () => {
    expect(computerTools(4096).map((t) => t.name)).not.toContain('screenshot');
    expect(computerTools(4096, true).map((t) => t.name)).toContain('screenshot');
    expect(computerTools(32768, true)).toHaveLength(COMPUTER_TOOLS.length + 1);
    expect(classify({ name: 'screenshot', args: {} }, undefined)).toEqual({
      decision: 'allow',
      tier: 'read',
    });
  });

  it('does nothing itself; the next step carries the picture', async () => {
    const ctx = { vision: {} } as unknown as AgentContext;
    await expect(executeTool({ name: 'screenshot', args: {} }, ctx)).resolves.toMatchObject({
      ok: true,
      summary: 'took a fresh screenshot',
    });
  });

  it('builds a text-only turn without a screenshot and a two-part turn with one', () => {
    expect(turnContent('hi')).toBe('hi');
    const parts = turnContent('hi', shot()) as ContentPart[];
    expect(parts).toEqual([
      { type: 'text', text: `hi\n\n${VISION_NOTE}` },
      { type: 'image', data: 'SU1H', mimeType: 'image/jpeg' },
    ]);
  });
});

// ---------- the loop with a fake page engine and camera ----------

function shot(): SetOfMarksResult {
  return {
    image: 'SU1H',
    width: 1024,
    height: 640,
    thumbnail: 'data:image/jpeg;base64,VA==',
    marks: 2,
  };
}

const VISION_MODEL: ModelRef = {
  instanceId: 'o',
  model: 'vlm',
  caps: { ...DEFAULT_CAPABILITIES, nativeTools: true, vision: true, contextLength: 8192 },
};

const toolCall = (name: string, args: Record<string, unknown>): Completion => ({
  text: '',
  reasoning: '',
  toolCalls: [{ id: 'c', name, arguments: JSON.stringify(args) }],
});

function setup(script: (Completion | Error)[], vision?: VisionApi) {
  const snap = (n: number): PageSnapshot => ({
    url: 'https://shop.test/',
    title: 'Shop',
    elements: [el('1', { x: 10, y: 10, w: 80, h: 20 }, { name: 'Next', value: String(n) })],
    dropped: 0,
    frames: [],
    text: 'A shop',
    links: [],
    scroll: { y: 0, height: 1000, viewport: 800 },
    hash: `h${n}`,
    captcha: false,
  });
  let state = 0;
  const requests: ChatStreamRequest[] = [];
  const events: AgentEvent[] = [];
  const trace = memoryTraceSink();
  const ctx: AgentContext = {
    tabId: 1,
    windowId: 1,
    signal: new AbortController().signal,
    policy: { allowDomains: [], blockDomains: [] },
    readPage: () => Promise.reject(new Error('unused')),
    waitForText: () => Promise.resolve(true),
    complete: () => Promise.resolve('{}'),
    tabs: {
      navigate: () => Promise.resolve(),
      goBack: () => Promise.resolve(),
      create: () => Promise.resolve(2),
      list: () =>
        Promise.resolve([{ id: 1, title: 'Shop', url: 'https://shop.test/', active: true }]),
      activate: () => Promise.resolve(),
      waitForLoad: () => Promise.resolve(),
    },
    page: {
      snapshot: () => Promise.resolve(snap(state)),
      act: () => {
        state += 1;
        return Promise.resolve({ ok: true, detail: 'clicked' });
      },
      stable: () => Promise.resolve(),
    },
    ...(vision ? { vision } : {}),
  };
  let i = 0;
  const input: RunInput = {
    runId: 'r',
    task: 'Go to the next page',
    model: VISION_MODEL,
    tools: computerTools(8192, !!vision),
    prefs: { ...DEFAULT_SETTINGS.agent, critique: false },
    ctx,
    complete: (req) => {
      requests.push(req);
      const next = script[i++];
      if (next instanceof Error) return Promise.reject(next);
      return next ? Promise.resolve(next) : Promise.reject(new Error('script exhausted'));
    },
    trace,
    emit: (e) => events.push(e),
  };
  return { input, requests, events, trace };
}

const images = (req: ChatStreamRequest | undefined) =>
  (req?.messages ?? []).flatMap((m) =>
    typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image'),
  );

describe('runAgent with vision', () => {
  it('sends one screenshot with each step, on the current turn only, and traces a thumbnail', async () => {
    let captures = 0;
    const { input, requests, trace } = setup(
      [toolCall('click', { id: '1' }), toolCall('done', { summary: 'ok' })],
      {
        capture: () => {
          captures += 1;
          return Promise.resolve(shot());
        },
      },
    );
    const r = await runAgent(input);
    expect(r.status).toBe('done');
    expect(captures).toBe(2);
    for (const req of requests) {
      expect(images(req)).toHaveLength(1);
      const last = req.messages.at(-1);
      expect(Array.isArray(last?.content)).toBe(true);
    }
    expect(trace.records.every((t) => t.thumbnail === 'data:image/jpeg;base64,VA==')).toBe(true);
  });

  it('sends no images when vision is off', async () => {
    const { input, requests } = setup([toolCall('done', { summary: 'ok' })]);
    await runAgent(input);
    expect(images(requests[0])).toHaveLength(0);
    expect(input.tools.map((t) => t.name)).not.toContain('screenshot');
  });

  it('carries on with text when a capture fails, warning once', async () => {
    const { input, requests, events } = setup(
      [toolCall('click', { id: '1' }), toolCall('done', { summary: 'ok' })],
      { capture: () => Promise.reject(new Error('cannot capture chrome:// pages')) },
    );
    const r = await runAgent(input);
    expect(r.status).toBe('done');
    expect(requests.map((q) => images(q).length)).toEqual([0, 0]);
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('Continuing with the page text');
  });

  it('drops screenshots for the run when the model rejects images, without losing the step', async () => {
    let captures = 0;
    const { input, requests, events } = setup(
      [
        new Error('HTTP 500: this model does not support images'),
        toolCall('click', { id: '1' }),
        toolCall('done', { summary: 'ok' }),
      ],
      {
        capture: () => {
          captures += 1;
          return Promise.resolve(shot());
        },
      },
    );
    const r = await runAgent(input);
    expect(r).toMatchObject({ status: 'done', steps: 2 });
    expect(requests.map((q) => images(q).length)).toEqual([1, 0, 0]);
    expect(captures).toBe(1);
    expect(JSON.stringify(events)).toContain('didn’t accept screenshots');
  });
});
