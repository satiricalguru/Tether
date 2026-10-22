import type { HandlerMap } from '@/lib/messaging';
import { performAction } from './actions';
import { elementPoint } from './point';
import { takeSnapshot } from './snapshot';
import { waitForStable } from './stability';

/** Content-script message handlers for the page engine. */
export function pageHandlers(): HandlerMap {
  return {
    'content:snapshot': ({ opts }) => takeSnapshot(document, window, opts),
    'content:act': ({ action }) => performAction(action),
    'content:stable': (opts) => waitForStable(document, opts),
    'content:point': ({ id }) => elementPoint(id),
  };
}
