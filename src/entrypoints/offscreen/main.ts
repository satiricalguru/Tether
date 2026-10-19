import { version } from '../../../package.json';
import { registerHandlers } from '@/lib/messaging';

/**
 * Offscreen document: a DOM-capable, long-lived context for work the service
 * worker can't do (canvas compositing for set-of-marks, audio). It answers
 * only `offscreen:*` messages.
 *
 * Offscreen documents get only the runtime *messaging* APIs: no
 * getManifest, storage or tabs. Anything else must be asked of the
 * background worker.
 */
registerHandlers({
  'offscreen:ping': () => ({ pong: true, version, at: Date.now() }),
});
