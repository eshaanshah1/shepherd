import type { ReactNode } from 'react';
import { Empty, KeyCap } from '@shepherd/ui';

/**
 * The stage with nothing on it — Flock rule 9's "personality lives in moments".
 *
 * The LAYOUT is now `Empty`, a primitive: an illustration slot, a serif
 * sentence, a hint. What stays here is the only part that is Shepherd's rather
 * than generic — **the ewe** — which is passed IN. She is the app's mascot, not
 * a decoration a contributed view's empty list should inherit.
 *
 * The serif is the *only* place the app is allowed to speak in sentences (rule
 * 6), and this is one of the three moments the language names for it (empty
 * states, errors, onboarding). It is now enforced by the primitive's stylesheet
 * rather than by this file remembering a class name — which matters, because for
 * the whole of this component's life it did not: `.sh-empty`, `.sh-ewe`,
 * `.sh-empty-say` and `.sh-empty-hint` had **no rules anywhere in the repo**, so
 * the ewe drew as solid black default-filled circles in the top-left corner of
 * the stage. Nobody saw it, because it was never reachable.
 *
 * **It is reachable now**, and that is the other half of this change. A root can
 * hold no panes: closing the last pane of the home root leaves it empty rather
 * than closing the window, so "nothing here" is a real projection and not only
 * the instant before main's first push. The old comment here said a zero-pane
 * projection never arrives; that was true and it was the bug.
 *
 * The ewe's fills are `--sh-*` variables, not the mock's unprefixed ones: the
 * renderer namespaces every token (see `cssVarName`), and a verbatim copy of the
 * mock's `var(--wool-dim)` resolves to nothing and draws an invisible sheep.
 */
export function EmptyState(): ReactNode {
  return (
    <Empty
      data-testid="empty-state"
      illustration={
        <svg className="sh-ewe" width="58" height="52" viewBox="0 0 58 52">
          <circle cx="29" cy="30" r="13" />
          <circle cx="20" cy="15" r="5" />
          <circle cx="29" cy="12" r="5.5" />
          <circle cx="38" cy="15" r="5" />
          <ellipse cx="11" cy="28" rx="5.5" ry="3" />
          <ellipse cx="47" cy="28" rx="5.5" ry="3" />
          <circle cx="24.5" cy="29" r="1.4" stroke="none" className="sh-ewe-eye" />
          <circle cx="33.5" cy="29" r="1.4" stroke="none" className="sh-ewe-eye" />
          <path d="M26.5 36 C27.5 37.2, 30.5 37.2, 31.5 36" />
        </svg>
      }
      hint={
        /*
         * `KeyCap`, not a `<span class="sh-key">` — and not a button either. The
         * primitive is display-only by construction (no `onClick` in its type),
         * which is the rule this hint has to obey: v2's sidebar footer put a
         * pressable `⌘T NEW TASK` keycap at the bottom of the list as the only
         * way to add a task, which teaches a shortcut instead of being a control.
         * It was replaced by a real `IconButton` at the top of the dock, and this
         * line survives as what it always was — a legend, in the one place where
         * a legend is the whole point.
         */
        <>
          <KeyCap>⌘T</KeyCap> COMPOSE A TASK
        </>
      }
    >
      Nothing grazing here yet.
    </Empty>
  );
}
