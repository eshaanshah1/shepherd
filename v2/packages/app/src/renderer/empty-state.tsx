import type { ReactNode } from 'react';
import { Button, Chip, Empty, KeyCap } from '@shepherd/ui';
import { PixelSheep } from './sky-strip.tsx';

/**
 * Why the stage is empty, when whoever is filling it said so.
 *
 * The shell does not know what a task is (ADR 0031). What it knows is that a
 * root can be empty for two unrelated reasons, and the one with something to say
 * says it here — a line, and the names of things that exist.
 */
export interface EmptyStateProps {
  readonly placeholder?: { readonly line: string; readonly names?: readonly string[] };
}

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
/**
 * The meadow — a hill and a sheep, and the app's ONLY illustration.
 *
 * Built once and used by both states below rather than written twice, which is
 * the rule this component's own note already states: two copies of the sheep are
 * two things that can drift into being two mascots. The sheep is `resting` in
 * both, including while a task is being built — it is the picture, not the
 * indicator, and the sentence under it is what reports the work.
 */
const meadow = (
  <span className="sh-meadow" aria-hidden="true">
    <i className="sh-meadow__hill" />
    <PixelSheep resting />
  </span>
);

export function EmptyState({ placeholder }: EmptyStateProps = {}): ReactNode {
  /**
   * The same surface, waiting rather than quiet — one branch, not a second
   * component.
   *
   * A root being built and a root with nothing in it are the same HOLE, and §10
   * refuses a card drawn in a hole. What changes is the three things that can
   * honestly differ: the sentence is the step the owner is on, the aside is the
   * names it is working with, and there is **no action** — the one thing you
   * could do here is already happening, and `New task` under `Creating the
   * worktree` offers to start a second one.
   *
   * The meadow stays. It is the app's only illustration and a wait is not a
   * different product.
   */
  if (placeholder !== undefined) {
    const names = placeholder.names ?? [];
    return (
      <Empty
        data-testid="empty-state"
        data-pending="true"
        /*
         * The sentence REPLACES itself as the work moves — `Naming the task`
         * becomes `Creating the worktree` — and a label that changes silently is
         * one a screen reader user watches happen to somebody else. `polite`
         * rather than `assertive`: it is progress, not an interruption.
         *
         * Only on this branch. The quiet state's sentence never changes, and a
         * live region over static text announces it on every unrelated re-render.
         */
        aria-live="polite"
        illustration={meadow}
        hint={
          names.length === 0 ? undefined : (
            <>
              {names.map((name) => (
                <Chip key={name}>{name}</Chip>
              ))}
            </>
          )
        }
      >
        {placeholder.line}
      </Empty>
    );
  }

  return (
    <Empty
      data-testid="empty-state"
      /*
       * A hill and a sheep, nothing else — this is the empty state, so the
       * picture has to be quieter than the button under it. The sheep is
       * `resting`: unlit, in the neutral ramp rather than in wool, because
       * nothing is grazing here.
       */
      illustration={meadow}
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
