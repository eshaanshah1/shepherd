// Cell metrics and motion, mock-approved. Rule 1: the character cell is the
// grid — chrome spacing derives from these, never from a 4px web scale.

export const metrics = {
  /** Terminal + chrome mono size, px. */
  fontSize: 13,
  /** One cell, px. Row height is a multiple of this and nothing else. */
  lineHeight: 20,
  /** A sidebar/list row: exactly 2 cells. */
  rowHeight: 28,
  microLabel: {
    fontSize: 10,
    /** em; the "WORKING · 3" instrument voice. */
    trackingMin: 0.1,
    trackingMax: 0.16,
  },
  hairline: 1,
} as const;

export const motion = {
  /** Sheep activity cycle. */
  flockCycleMs: 500,
  /** Block cursor, steps() not ease. */
  cursorBlinkMs: 1100,
  /** ScrambleText tick. */
  scrambleTickMs: 70,
  /** Rule 7: 120–180ms, near-linear, and nothing bounces. */
  transitionMs: 140,
} as const;

/**
 * The bundled placeholder face.
 * TODO(pre-1.0): license Berkeley Mono (or an equivalent characterful mono)
 * and replace this — design language rule 6. JetBrains Mono is carried over
 * from v1's resources so nothing blocks on the licence.
 */
export const fonts = {
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  /** Rule 6: serif only where the app speaks in sentences. */
  serif: "'Iowan Old Style', Palatino, Georgia, serif",
} as const;
