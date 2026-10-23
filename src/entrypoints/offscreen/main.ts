import { registerHandlers } from '@/lib/messaging';
import { OFFSCREEN_HANDLERS } from '@/offscreen/handlers';

/**
 * Offscreen document: a DOM-capable, long-lived context for work the service
 * worker can't do (canvas compositing for set-of-marks, audio). It answers
 * only `offscreen:*` messages, defined in src/offscreen/handlers.ts.
 *
 * Offscreen documents get only the runtime *messaging* APIs: no
 * getManifest, storage or tabs. Anything else must be asked of the
 * background worker.
 */
registerHandlers(OFFSCREEN_HANDLERS);
