import type { ToolSpec } from '../types';

/**
 * Phase 4: read-only tools. Phase 5 adds the interaction set (click, type,
 * select, scroll…). Every extra tool costs small models accuracy, so each
 * one earns its place.
 */
export const READ_ONLY_TOOLS: ToolSpec[] = [
  {
    name: 'navigate',
    description: 'Open a URL in the current tab. To follow a link, use its URL from LINKS.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full web address of the page' },
      },
      required: ['url'],
    },
  },
  {
    name: 'back',
    description: 'Go back to the previous page in the current tab.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'newTab',
    description: 'Open a URL in a new tab and switch to it.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'switchTab',
    description: 'Switch to another open tab by its index from TABS.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
    },
  },
  {
    name: 'waitFor',
    description:
      'Wait for content that is still loading: give a short exact phrase you expect to appear (e.g. "results found"), or "load". Don’t wait for text you’ve already seen.',
    parameters: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'Text to wait for, or "load"' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 15000 },
      },
      required: ['condition'],
    },
  },
  {
    name: 'extract',
    description:
      'Extract structured data from the current page. schema maps field names to types, e.g. {"name":"string","price":"number"}; wrap in [ ] for a list.',
    parameters: {
      type: 'object',
      properties: {
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
          description: 'Fields to extract',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'askUser',
    description:
      'Ask the user a question when you cannot continue without them (login, CAPTCHA, a choice).',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
    terminal: true,
  },
  {
    name: 'done',
    description: 'Finish the task. summary answers the user; result holds any data you collected.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The answer for the user' },
        result: { type: 'object', properties: {}, additionalProperties: true },
      },
      required: ['summary'],
    },
    terminal: true,
  },
];

export function specByName(tools: ToolSpec[], name: string): ToolSpec | undefined {
  return tools.find((t) => t.name === name);
}

const ID = { type: 'string' as const, description: 'Element id, e.g. 12 or 3.12' };

/** Phase 5: the full action space (spec §6.2); `screenshot` is added for the vision tier. */
export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: 'navigate',
    description:
      'Open a URL in the current tab. To follow a link, click it or use the address shown after →.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full web address of the page' } },
      required: ['url'],
    },
  },
  ...READ_ONLY_TOOLS.filter((t) => ['back', 'newTab', 'switchTab'].includes(t.name)),
  {
    name: 'forward',
    description: 'Go forward in the current tab.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'closeTab',
    description: 'Close a tab by its index from TABS.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
    },
  },
  {
    name: 'click',
    description: 'Click an element.',
    parameters: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'rightClick',
    description: 'Right-click an element (opens its context menu).',
    parameters: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (reveals menus and tooltips).',
    parameters: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'type',
    description:
      'Type text into a field, replacing what it holds. submit=true presses Enter afterwards.',
    parameters: {
      type: 'object',
      properties: { id: ID, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'clear',
    description: 'Empty a text field.',
    parameters: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'setValue',
    description: 'Set a field to a value directly (dates, sliders, numbers).',
    parameters: {
      type: 'object',
      properties: { id: ID, value: { type: 'string' } },
      required: ['id', 'value'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown by its visible text.',
    parameters: {
      type: 'object',
      properties: { id: ID, option: { type: 'string' } },
      required: ['id', 'option'],
    },
  },
  {
    name: 'check',
    description: 'Tick (true) or untick (false) a checkbox, radio button or switch.',
    parameters: {
      type: 'object',
      properties: { id: ID, state: { type: 'boolean' } },
      required: ['id', 'state'],
    },
  },
  {
    name: 'pressKey',
    description: 'Press a key: Enter, Escape, Tab, ArrowDown, Ctrl+A… Optionally on an element.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, id: ID },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down, or scroll an element into view.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        id: ID,
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Screens to scroll (default 1)',
        },
      },
    },
  },
  ...READ_ONLY_TOOLS.filter((t) => ['waitFor', 'extract', 'askUser', 'done'].includes(t.name)),
];

/** Left out of small windows: rarely needed, and every schema costs prompt space. */
const EXTRA_TOOLS = new Set([
  'newTab',
  'switchTab',
  'forward',
  'reload',
  'closeTab',
  'rightClick',
  'hover',
]);

/** Vision tier only (spec §6.5): refresh the screenshot without acting. */
export const SCREENSHOT_TOOL: ToolSpec = {
  name: 'screenshot',
  description:
    'Look at the page again: the next step comes with a fresh screenshot. Use it after the page changed on its own (an animation, a slow load).',
  parameters: { type: 'object', properties: {} },
};

/**
 * The computer-use tool set for a model window: the core 14 up to 8K tokens,
 * all 21 above, plus `screenshot` when the vision tier is on.
 */
export function computerTools(window: number, vision = false): ToolSpec[] {
  const base =
    window > 8192 ? COMPUTER_TOOLS : COMPUTER_TOOLS.filter((t) => !EXTRA_TOOLS.has(t.name));
  return vision ? [...base, SCREENSHOT_TOOL] : base;
}

/** Tools whose `id` argument must exist in the current snapshot. */
export const ELEMENT_TOOLS = new Set([
  'click',
  'rightClick',
  'hover',
  'type',
  'clear',
  'setValue',
  'select',
  'check',
]);
