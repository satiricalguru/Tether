import { resolveTarget } from './snapshot';
import type { ElementPoint } from './types';

/**
 * Where a trusted (CDP) click should land for an id: the center of its click
 * target in top-level viewport CSS pixels, after scrolling it into view.
 * Same-origin frame offsets are added; null if the element is gone or has
 * no box.
 */
export function elementPoint(id: string): ElementPoint | null {
  const el = resolveTarget(id);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let win: Window | null = el.ownerDocument.defaultView;
  while (win && win !== win.parent) {
    let frame: Element | null;
    try {
      frame = win.frameElement;
    } catch {
      frame = null;
    }
    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    x += fr.left + frame.clientLeft;
    y += fr.top + frame.clientTop;
    win = win.parent;
  }
  return { x: Math.round(x), y: Math.round(y) };
}
