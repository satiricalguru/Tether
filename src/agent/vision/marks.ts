import type { SnapshotElement } from '@/agent/page/types';

/**
 * Set-of-marks geometry (spec §6.5). Pure, so it's tested without a canvas.
 *
 * Marks reuse the DOM snapshot's element ids: the model answers with an id,
 * which resolves through the page engine as on the text tiers. Pixel
 * coordinates a model might send back are never used.
 */

/** A numbered box in screenshot pixels. */
export interface Mark {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Long side of the image sent to the model, by default. */
export const DEFAULT_VISION_SIDE = 1024;
/** Long side of the thumbnail kept in the trace. */
export const THUMB_SIDE = 320;
/**
 * Rough prompt cost of one image at 1024 px. Local VLMs vary (LLaVA-style
 * projectors use a fixed ~576 tokens, Qwen2.5-VL ~1 token per 28×28 patch),
 * so this is a budget estimate, not a count; it scales with area.
 */
const TOKENS_AT_1024 = 800;

export function imageTokens(maxSide: number): number {
  const side = Math.max(256, Math.min(2048, maxSide));
  return Math.round(TOKENS_AT_1024 * (side / DEFAULT_VISION_SIDE) ** 2);
}

/** Scale `size` down (never up) so its long side is at most `maxSide`. */
export function fitWithin(size: Size, maxSide: number): Size {
  const long = Math.max(size.width, size.height);
  if (long <= maxSide || long === 0) return { width: size.width, height: size.height };
  const k = maxSide / long;
  return {
    width: Math.max(1, Math.round(size.width * k)),
    height: Math.max(1, Math.round(size.height * k)),
  };
}

/**
 * Boxes for the listed, on-screen elements, in screenshot pixels.
 * `scale` converts CSS px to screenshot px (the device pixel ratio as
 * captured). Boxes are clipped to the image; ones left smaller than a few
 * pixels are dropped, since a label on them would cover something else.
 */
export function marksFor(elements: SnapshotElement[], scale: number, image: Size): Mark[] {
  const out: Mark[] = [];
  for (const e of elements) {
    if (!e.inViewport) continue;
    const x0 = Math.max(0, e.rect.x * scale);
    const y0 = Math.max(0, e.rect.y * scale);
    const x1 = Math.min(image.width, (e.rect.x + e.rect.w) * scale);
    const y1 = Math.min(image.height, (e.rect.y + e.rect.h) * scale);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    out.push({
      id: e.id,
      x: Math.round(x0),
      y: Math.round(y0),
      w: Math.round(x1 - x0),
      h: Math.round(y1 - y0),
    });
  }
  return out;
}

/**
 * Where a mark's label goes: just above its top-left corner, or inside the
 * box when there's no room above. Kept within the image.
 */
export function labelPosition(mark: Mark, label: Size, image: Size): { x: number; y: number } {
  const above = mark.y - label.height;
  const y = above >= 0 ? above : mark.y;
  const x = Math.min(Math.max(0, mark.x), Math.max(0, image.width - label.width));
  return { x, y: Math.min(y, Math.max(0, image.height - label.height)) };
}

/** A provider error that means "this model or server doesn't take images". */
export function isImageRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /image|vision|multimodal|multi-modal|projector|mmproj/i.test(msg) &&
    /not support|unsupported|cannot|can't|does not|doesn't|invalid|failed|missing|no .*(projector|mmproj)/i.test(
      msg,
    )
  );
}
