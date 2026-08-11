import type { ReactNode } from 'react';
import { Button, Empty, KeyCap } from '@shepherd/ui';
import { PixelSheep } from './sky-strip.tsx';

/**
 * The stage with nothing on it.
 *
 * A 180×56 meadow — one hill, one sheep, at rest and unlit — then `The flock is
 * quiet.`, a sub-line, and the panel's one primary action.
 *
 * Two things changed from Flock's version, and both are §2:
 *
 *   - **No serif.** Flock kept a third face for "where the app speaks in
 *     sentences". This language has two, split by job: what the app says is
 *     sans, what the machine produced is mono. An empty state is the app
 *     talking, so it is sans — and the sentence carries by SIZE and weight
 *     rather than by changing voice.
 *   - **The hint stopped being an uppercase tracked legend.** §6 refuses those,
 *     and a legend that shouts under a quiet sentence is the specific thing it
 *     is refusing.
 *
 * The sheep is the same component the rail's sky strip draws, imported rather
 * than redrawn: it is the app's ONLY illustration, and two copies of it are two
 * things that can drift into being two mascots.
 */
export function EmptyState(): ReactNode {
  return (
    <Empty
      data-testid="empty-state"
      illustration={
        /*
         * The meadow. A hill and a sheep, nothing else — this is the empty
         * state, so the picture has to be quieter than the button under it.
         * The sheep is `resting`: unlit, in the neutral ramp rather than in
         * wool, because nothing is grazing here.
         */
        <span className="sh-meadow" aria-hidden="true">
          <i className="sh-meadow__hill" />
          <PixelSheep resting />
        </span>
      }
      hint={
        /*
         * `KeyCap`, not a `<span class="sh-key">` — and not a button either. The
         * primitive is display-only by construction (no `onClick` in its type),
         * which is the rule this hint has to obey: a pressable keycap as the only
         * way to add a task teaches a shortcut instead of being a control. The
         * real control is the Button above it; this is the legend beside it.
         */
        <>
          Press <KeyCap>⌘T</KeyCap> to start one
        </>
      }
      action={
        /*
         * ONE primary per surface, and on an empty stage this is unambiguously
         * it: there is nothing else here to compete with.
         */
        <Button
          variant="primary"
          size="md"
          data-testid="empty-compose"
          onClick={() => window.dispatchEvent(new CustomEvent('sh:raise-view', { detail: 'tasks.composer' }))}
        >
          New task
        </Button>
      }
    >
      The flock is quiet.
    </Empty>
  );
}
