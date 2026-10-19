import { browser } from 'wxt/browser';
import { registerHandlers } from '@/lib/messaging';

/**
 * Offscreen document: a DOM-capable, long-lived context for work the service
 * worker can't do (canvas compositing for set-of-marks, audio). It answers
 * only `offscreen:*` messages.
 */
registerHandlers({
  'offscreen:ping': () => ({
    pong: true,
    version: browser.runtime.getManifest().version,
    at: Date.now(),
  }),
});
