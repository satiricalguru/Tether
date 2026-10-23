import { fitWithin, labelPosition, marksFor, THUMB_SIDE, type Mark } from './marks';
import type { SnapshotElement } from '@/agent/page/types';

/**
 * Draws the set-of-marks overlay and downscales it. Uses only
 * `createImageBitmap` and `OffscreenCanvas`, so the same code runs in the
 * offscreen document (Chromium) and in a background page with a DOM
 * (Firefox). See src/platform/som.ts for which one is used.
 */

export interface SetOfMarksRequest {
  /** The captured tab, as a data: URL (JPEG or PNG). */
  screenshot: string;
  elements: SnapshotElement[];
  /** Viewport height in CSS px (from the snapshot); with the image height, gives the scale. */
  viewportHeight: number;
  maxSide: number;
}

export interface SetOfMarksResult {
  /** Base64 JPEG without the data: prefix, ready for an image message part. */
  image: string;
  width: number;
  height: number;
  /** Small JPEG data: URL for the trace. */
  thumbnail: string;
  marks: number;
}

const BOX = '#e11d48';
const LABEL_BG = '#e11d48';
const LABEL_FG = '#ffffff';

async function dataUrlToBlob(url: string): Promise<Blob> {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Promise.resolve(new Blob([bytes], { type: meta.replace(/;base64$/, '') }));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas context available.');
  return ctx;
}

function drawMarks(ctx: OffscreenCanvasRenderingContext2D, marks: Mark[], k: number): void {
  const line = Math.max(1, Math.round(2 * k));
  const font = Math.max(10, Math.round(13 * k));
  ctx.lineWidth = line;
  ctx.strokeStyle = BOX;
  ctx.font = `bold ${font}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const image = { width: ctx.canvas.width, height: ctx.canvas.height };
  for (const m of marks) {
    ctx.strokeRect(m.x + line / 2, m.y + line / 2, m.w - line, m.h - line);
  }
  // Labels after all boxes, so a box never draws over a neighbour's number.
  for (const m of marks) {
    const text = m.id;
    const pad = Math.round(2 * k);
    const label = {
      width: Math.ceil(ctx.measureText(text).width) + pad * 2,
      height: font + pad * 2,
    };
    const at = labelPosition(m, label, image);
    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(at.x, at.y, label.width, label.height);
    ctx.fillStyle = LABEL_FG;
    ctx.fillText(text, at.x + pad, at.y + pad);
  }
}

export async function drawSetOfMarks(req: SetOfMarksRequest): Promise<SetOfMarksResult> {
  const bitmap = await createImageBitmap(await dataUrlToBlob(req.screenshot));
  try {
    const size = fitWithin({ width: bitmap.width, height: bitmap.height }, req.maxSide);
    // Screenshot px per CSS px, then down to the output size.
    const captureScale = req.viewportHeight > 0 ? bitmap.height / req.viewportHeight : 1;
    const k = size.width / bitmap.width;
    const marks = marksFor(req.elements, captureScale * k, size);

    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = context(canvas);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    // Line and font sizes follow the output size, not the device pixel ratio.
    drawMarks(ctx, marks, Math.max(0.75, size.width / 1024));
    const image = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });

    const t = fitWithin(size, THUMB_SIDE);
    const thumb = new OffscreenCanvas(t.width, t.height);
    context(thumb).drawImage(canvas, 0, 0, t.width, t.height);
    const thumbBlob = await thumb.convertToBlob({ type: 'image/jpeg', quality: 0.6 });

    return {
      image: await blobToBase64(image),
      width: size.width,
      height: size.height,
      thumbnail: `data:image/jpeg;base64,${await blobToBase64(thumbBlob)}`,
      marks: marks.length,
    };
  } finally {
    bitmap.close();
  }
}
