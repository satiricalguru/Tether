import { version } from '../../package.json';
import { drawSetOfMarks } from '@/agent/vision/draw';
import type { HandlerMap } from '@/lib/messaging';

/**
 * Work that needs a DOM (canvas compositing for set-of-marks, …). On
 * Chromium these run in the offscreen document; on Firefox, which has no
 * offscreen documents, the background page has a DOM and runs them in place.
 * Reach them through `callOffscreen` (src/platform/offscreen.ts), never by
 * messaging directly, so both paths stay the same.
 */
export const OFFSCREEN_HANDLERS: HandlerMap = {
  'offscreen:ping': () => ({ pong: true, version, at: Date.now() }),
  'offscreen:som': (req) => drawSetOfMarks(req),
};
