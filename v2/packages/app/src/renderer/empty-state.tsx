import type { ReactNode } from 'react';

/**
 * The stage with nothing on it — Flock rule 9's "personality lives in moments".
 *
 * Copied from the approved mock's `.empty` section: a line-drawn ewe, one dry
 * serif sentence, and a keycap hint. The serif is the *only* place the app is
 * allowed to speak in sentences (rule 6), and this is one of the three moments
 * the language names for it (empty states, errors, onboarding).
 *
 * **Where it is rendered matters.** It draws for `snapshots === null` and
 * nothing else: the window before main's first push. Core keeps the tree intact
 * when the last pane closes and closes the window instead, so a zero-pane
 * projection never arrives — there is no other empty state to compete with this
 * one, and wiring it to a "pane with no bytes yet" would be a second opinion
 * about emptiness that the snapshot cannot support.
 *
 * The ewe's fills are `--sh-*` variables, not the mock's unprefixed ones: the
 * renderer namespaces every token (see `cssVarName`), and a verbatim copy of the
 * mock's `var(--wool-dim)` resolves to nothing and draws an invisible sheep.
 */
export function EmptyState(): ReactNode {
  return (
    <div className="sh-empty" data-testid="empty-state">
      <svg className="sh-ewe" width="58" height="52" viewBox="0 0 58 52" aria-hidden="true">
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
      <p className="sh-empty-say">Nothing grazing here yet.</p>
      <p className="sh-empty-hint">
        <span className="sh-key">⌘T</span> COMPOSE A TASK
      </p>
    </div>
  );
}
