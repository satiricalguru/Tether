import type { ObjectSchema, ToolSpec } from '../../../src/agent/types.ts';

/**
 * The full computer-use action space (spec §6.2) with realistic schemas.
 * Used by the parser corpus test and the capture script, so captured model
 * outputs and their expectations are judged against the same tools.
 */

const id = { type: 'integer', description: 'Element id from the page snapshot' } as const;

function obj(properties: ObjectSchema['properties'], required: string[] = []): ObjectSchema {
  return { type: 'object', properties, required };
}

export const CORPUS_TOOLS: ToolSpec[] = [
  {
    name: 'navigate',
    description: 'Go to a URL in the current tab',
    parameters: obj({ url: { type: 'string' } }, ['url']),
  },
  { name: 'back', description: 'Go back in history', parameters: obj({}) },
  { name: 'forward', description: 'Go forward in history', parameters: obj({}) },
  { name: 'reload', description: 'Reload the page', parameters: obj({}) },
  { name: 'click', description: 'Click an element', parameters: obj({ id }, ['id']) },
  { name: 'rightClick', description: 'Right-click an element', parameters: obj({ id }, ['id']) },
  { name: 'hover', description: 'Hover over an element', parameters: obj({ id }, ['id']) },
  {
    name: 'type',
    description: 'Type text into a field',
    parameters: obj(
      {
        id,
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter afterwards' },
      },
      ['id', 'text'],
    ),
  },
  { name: 'clear', description: 'Clear a field', parameters: obj({ id }, ['id']) },
  {
    name: 'setValue',
    description: 'Set a field value directly',
    parameters: obj({ id, value: { type: 'string' } }, ['id', 'value']),
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown',
    parameters: obj({ id, option: { type: 'string' } }, ['id', 'option']),
  },
  {
    name: 'check',
    description: 'Tick or untick a checkbox',
    parameters: obj({ id, state: { type: 'boolean' } }, ['id', 'state']),
  },
  {
    name: 'pressKey',
    description: 'Press a key, e.g. Enter, Escape, Tab, ArrowDown, Ctrl+A',
    parameters: obj({ key: { type: 'string' } }, ['key']),
  },
  {
    name: 'scroll',
    description: 'Scroll the page or an element',
    parameters: obj({
      direction: { type: 'string', enum: ['up', 'down'] },
      id: { type: 'integer', description: 'Element to scroll into view' },
      amount: { type: 'integer', description: 'Screens to scroll' },
    }),
  },
  { name: 'newTab', description: 'Open a new tab', parameters: obj({ url: { type: 'string' } }) },
  {
    name: 'switchTab',
    description: 'Switch to a tab by index',
    parameters: obj({ index: { type: 'integer' } }, ['index']),
  },
  {
    name: 'closeTab',
    description: 'Close a tab by index',
    parameters: obj({ index: { type: 'integer' } }, ['index']),
  },
  { name: 'screenshot', description: 'Take a screenshot', parameters: obj({}) },
  {
    name: 'extract',
    description: 'Extract structured data from the current page',
    parameters: obj({ schema: { type: 'object', properties: {}, additionalProperties: true } }, [
      'schema',
    ]),
  },
  {
    name: 'waitFor',
    description: 'Wait until text appears or the page loads',
    parameters: obj({ condition: { type: 'string' }, timeoutMs: { type: 'integer' } }, [
      'condition',
    ]),
  },
  {
    name: 'askUser',
    description: 'Ask the user a question and stop',
    parameters: obj({ question: { type: 'string' } }, ['question']),
    terminal: true,
  },
  {
    name: 'done',
    description: 'Finish with a summary for the user',
    parameters: obj({ summary: { type: 'string' }, result: { type: 'string' } }, ['summary']),
    terminal: true,
  },
];
