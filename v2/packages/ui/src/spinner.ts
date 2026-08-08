import { useEffect, useState } from 'react';
import { motion } from '@shepherd/design-tokens';

/**
 * The braille spinner — Flock rule 7's working indicator, in text.
 *
 * Rule 7 names it explicitly (`⠋⠙⠹…`) and bans the alternative in the same
 * breath: no spinners-as-rings, no shimmer, no pulse. The point is not novelty —
 * a rotating ring is a picture of waiting, whereas a braille cell advancing is
 * the same thing a terminal has always drawn, so the chrome and the grid agree
 * about what "busy" looks like. It is also why this is a STRING and not an SVG:
 * a glyph inherits the label's colour, its size and its line box for free, which
 * is what lets it stand in a button's label slot without moving anything.
 *
 * Ten frames, the standard cli-spinners `dots` sequence. Each is one character
 * wide in every monospace face, so the frame index cannot change a width.
 */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * The tick, borrowed from `motion.scrambleTickMs` (70ms).
 *
 * FINDING, reported with this wave: `motion` has no spinner cadence of its own.
 * `scrambleTickMs` is the nearest honest neighbour — it is the other textual
 * motion in the language and it is a *character* rate rather than a transition
 * duration, so `transitionMs` (140, and documented as the 120–180ms easing
 * window) would have been the wrong one to reach for. If a spinner cadence is
 * ever added to the token set this constant is the single edit.
 */
export const SPINNER_TICK_MS = motion.scrambleTickMs;

/**
 * True when the user has asked the OS for less motion.
 *
 * Guarded on `matchMedia` existing at all: jsdom does not implement it, and a
 * primitive that threw in a test environment would make every component that
 * merely *can* spin untestable. Reduced motion is the safe answer when we cannot
 * ask.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The current frame while `active`, frame 0 otherwise.
 *
 * Under reduced motion it stays on frame 0 — a static braille cell, which still
 * reads as "something is happening here" in a way an empty box does not. Rule 7's
 * last line is that motion respects the preference, not that the indicator
 * disappears with it.
 */
export function useBrailleFrame(active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      // Back to the first frame, so a button that stops and restarts does not
      // resume mid-sequence — which reads as a stutter rather than as a restart.
      setIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % BRAILLE_FRAMES.length);
    }, SPINNER_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return BRAILLE_FRAMES[index] ?? BRAILLE_FRAMES[0];
}
