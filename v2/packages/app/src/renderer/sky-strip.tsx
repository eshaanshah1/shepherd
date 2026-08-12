import type { ReactElement } from 'react';

/**
 * The sky strip — §5's one decorative surface, and the only illustration in the
 * product.
 *
 * A dim gradient, a few 1px stars, three hills, and a 3px-pixel sheep grazing at
 * its right-hand end, with the panel's name overlaid at its foot.
 *
 * **It is a window, not a wallpaper.** An earlier version spread the scene
 * behind the whole app and it was distracting — the app hosts other people's
 * programs, and a decorative ground competes with the one thing that changed.
 * Keeping it to a 124px strip is the entire discipline here; anything that makes
 * this reusable somewhere else is a change to the design, not a refactor.
 *
 * **No image asset.** The sheep is drawn as 3px `<span>` pixels, which is why it
 * is pixel-exact at 1× and integer-scaled above it — a PNG at 27×21 would be
 * resampled to mush on a non-integer scale factor, and an SVG would antialias
 * the pixel grid that IS the character of it. It is the mascot the state marks
 * abstract, which is the other reason it is drawn from the same vocabulary they
 * are: squares, in a fixed grid.
 *
 * Everything positional here is a literal px for the reason `state-mark.css`
 * gives: these are the coordinates of a DRAWING. A scene that reflowed with the
 * density mode would not be the same scene.
 */

/** The stars: `[left%, top, size, opacity]`, scattered in the top 55px. */
const STARS: ReadonlyArray<readonly [number, number, number, number]> = [
  [12, 14, 2, 0.55],
  [26, 31, 1, 0.32],
  [38, 9, 1, 0.42],
  [51, 24, 2, 0.28],
  [63, 41, 1, 0.5],
  [72, 17, 1, 0.35],
  [84, 36, 2, 0.22],
  [93, 12, 1, 0.46],
];

/**
 * The sheep, as a 27×21 box of 3px pixels.
 *
 * `[x, y, w, h, part]` — three fluff squares along the top, a 21×9 body, a 6×6
 * head, a 3×3 eye, and two 3×6 legs. Every number is a multiple of 3 because the
 * grid is: a pixel off the grid is the one thing that would make this read as a
 * bad drawing rather than a small one.
 */
const SHEEP: ReadonlyArray<readonly [number, number, number, number, 'wool' | 'shade' | 'eye']> = [
  [6, 0, 3, 3, 'wool'],
  [12, 0, 3, 3, 'wool'],
  [18, 0, 3, 3, 'wool'],
  [3, 3, 21, 9, 'wool'],
  [0, 6, 6, 6, 'shade'],
  [0, 9, 3, 3, 'eye'],
  [9, 12, 3, 6, 'shade'],
  [18, 12, 3, 6, 'shade'],
];

/**
 * The sheep, on its own, so the empty state's meadow and the rail's strip draw
 * the SAME animal.
 *
 * Exported rather than duplicated because it is the app's only illustration —
 * two copies of it is two things that can drift into being two mascots, and the
 * pixel grid is exactly the sort of detail that drifts.
 */
export function PixelSheep({ resting = false }: { readonly resting?: boolean }): ReactElement {
  return (
    <span className="sh-sky__sheep" data-resting={resting ? 'true' : undefined}>
      {SHEEP.map(([x, y, w, h, part], index) => (
        <i key={index} data-part={part} style={{ left: `${x}px`, top: `${y}px`, inlineSize: `${w}px`, blockSize: `${h}px` }} />
      ))}
    </span>
  );
}

export interface SkyStripProps {
  /** The panel's name — 19/600, once per panel, overlaid at the strip's foot. */
  readonly title: string;
  /** How many tasks, in mono beside the title. */
  readonly count?: number;
  /** The panel's one primary action, drawn at the strip's trailing edge. */
  readonly action?: ReactElement;
}

export function SkyStrip({ title, count, action }: SkyStripProps): ReactElement {
  return (
    <div className="sh-sky" data-testid="sky-strip">
      {/*
        Decorative in the accessibility sense as well as the visual one: there is
        no information here that is not also in the title below it, and a screen
        reader announcing eight stars and a sheep would be reading the wallpaper
        aloud.
      */}
      <div className="sh-sky__scene" aria-hidden="true">
        {STARS.map(([left, top, size, opacity], index) => (
          <i
            key={index}
            className="sh-sky__star"
            style={{ left: `${left}%`, top: `${top}px`, inlineSize: `${size}px`, blockSize: `${size}px`, opacity }}
          />
        ))}
        {/*
          Three hills, each a very wide ellipse clipped by the strip. The radii
          are asymmetric (`100% 100% 0 0 / Npx Npx`) so the crown is shallow and
          the flanks fall away — a symmetric radius reads as a bubble.
        */}
        <i className="sh-sky__hill" style={{ left: -40, width: 280, height: 66, borderRadius: '100% 100% 0 0 / 62px 62px' }} />
        <i className="sh-sky__hill sh-sky__hill--far" style={{ right: -60, width: 300, height: 62, borderRadius: '100% 100% 0 0 / 56px 56px' }} />
        <i className="sh-sky__hill sh-sky__hill--near" style={{ left: -10, width: 400, height: 44, borderRadius: '100% 100% 0 0 / 34px 34px' }} />

        <PixelSheep />
      </div>

      {/*
        The panel's name sits at the strip's FOOT, over the scene rather than
        below it. That is what makes the strip a window: the chrome and the
        picture share a box, so the picture is bounded by something with a job
        instead of being a band of its own.
      */}
      <div className="sh-sky__head">
        <h1 className="sh-sky__title">{title}</h1>
        {count === undefined ? null : <span className="sh-sky__count">{count}</span>}
        <span className="sh-sky__spacer" />
        {action}
      </div>
    </div>
  );
}
