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
