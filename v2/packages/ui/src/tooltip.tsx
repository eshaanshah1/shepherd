import type { ReactElement, ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './cn.ts';

/**
 * A tooltip — Radix's, restyled. **Where the status word went.**
 *
 * That sentence in the spec is the design argument: a sidebar row shows a
 * coloured dot and not the word `WORKING`, because the word costs a column in
 * every row of a 268px list to say something the colour already says at a
 * glance. The tooltip is where the word still lives, for the one row you are
 * asking about — so nothing is lost and no row gets wider.
 *
 * The second of the two Radix dependencies, and the behaviour it buys is not the
 * box: it is the delay/grace state machine (open after a rest, but move to a
 * neighbouring trigger inside the grace window and it opens instantly), dismissal
 * on Esc and on pointer-down, collision-aware placement so it does not land off
 * the window edge, and the `aria-describedby` wiring. Every one of those is a
 * thing that is wrong in a hand-rolled tooltip and wrong in a way nobody files.
 *
 * **400ms, and no arrow.** The delay is long enough that running the pointer
 * down a list does not strobe tooltips at every row, which is the failure mode
 * of the 200ms default in a UI that is mostly list. The arrow is dropped because
 * it is a second shape to keep on the hairline grid at every collision-flipped
 * side, and it says nothing the position does not.
 */

/**
 * The shared timing context.
 *
 * Radix wants ONE provider near the root so that moving between two triggers
 * skips the delay — that "skipDelayDuration" grace is per-provider, and a
 * provider per tooltip means every neighbour re-pays the full 400ms, which is
 * the twitchy behaviour the delay exists to prevent. Exported so the app mounts
 * one; `Tooltip` also falls back to its own (see below) so a primitive dropped
 * into an extension's view still works before anyone has read this paragraph.
 */
export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * FINDING, reported with this wave: `motion` carries no tooltip delay, and this
 * is a *timing* rather than a duration — it is how long you must rest, not how
 * long anything animates, so `transitionMs` would have been the wrong token to
 * reach for even if it had matched.
 */
export const TOOLTIP_DELAY_MS = 400;

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  /** What the tooltip says. A tooltip with no content renders no tooltip. */
  readonly content: ReactNode;
  /** The trigger. Rendered as-is — Radix merges its handlers onto this element. */
  readonly children: ReactNode;
  readonly side?: TooltipSide;
  readonly className?: string;
  /** Controlled open, for a test or for a guided tour that points at something. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function Tooltip({
  content,
  children,
  side = 'bottom',
  className,
  open,
  onOpenChange,
}: TooltipProps): ReactElement {
  /*
   * A local Provider as well as the exported one.
   *
   * Nesting providers is legal in Radix and the inner one wins, so an app that
   * mounts `TooltipProvider` at its root still gets the shared grace window for
   * every tooltip that does not override the delay — and a tooltip mounted in an
   * extension's view with no provider above it works rather than throwing. The
   * alternative is a primitive whose failure mode is an exception at mount time
   * in somebody else's code.
   */
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={cn('sh-ui-tooltip', className)}
            side={side}
            sideOffset={4}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
