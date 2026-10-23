import type { SetOfMarksRequest, SetOfMarksResult } from '@/agent/vision/draw';
import { callOffscreen } from './offscreen';

/**
 * Set-of-marks compositing for the vision tier: in the offscreen document on
 * Chromium, in place in the background page on Firefox (see callOffscreen).
 */
export function composeSetOfMarks(req: SetOfMarksRequest): Promise<SetOfMarksResult> {
  return callOffscreen('offscreen:som', req, {
    reasons: ['BLOBS'],
    justification: 'Draw numbered element boxes on a tab screenshot for a vision model.',
  });
}
