/**
 * How big a pasted image is allowed to be — the pure half.
 *
 * A screenshot off a Retina display is 2–3 MB of PNG, and every byte of it is
 * written to disk per task and then read into a context window. The model does
 * not get more out of the extra pixels: an image whose long edge is over
 * `MAX_EDGE` is scaled down before it is looked at, so anything above the line
 * is cost with no answer attached to it.
 *
 * This file only DECIDES. The resize itself needs a canvas, which exists in the
 * renderer and nowhere else — the decision is separated so it can be tested
 * without one, and so the composer and any later caller cannot disagree about
 * where the line is.
 */

/**
 * The long edge, in px.
 *
 * 1568 is the width images have historically been scaled to. The newest models
 * accept more (2576), and this deliberately does not chase it: a paste is a
 * screenshot for context, not a page to be read letter by letter, and the
 * smaller bound is correct against every model rather than the latest one.
 */
export const MAX_EDGE = 1568;

export interface DownsizePlan {
  readonly width: number;
  readonly height: number;
  /** 1 when the image is already small enough — nothing to do. */
  readonly scale: number;
}

/**
 * Aspect ratio is preserved, and the short edge is rounded rather than floored:
 * a 1-px difference is invisible and a 0-px edge is a canvas that throws.
 */
export function planDownsize(width: number, height: number): DownsizePlan {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height, scale: 1 };

  const scale = MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
