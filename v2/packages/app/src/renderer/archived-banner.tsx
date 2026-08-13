import type { ReactNode } from 'react';

/**
 * What a root of captured screens says about itself, and the one verb that ends
 * that state.
 *
 * The counterpart of `EmptyState`, and deliberately a different component rather
 * than a mode of it: an empty root is drawn INSTEAD of a tree, and this is drawn
 * OVER one. Both read the same `placeholder` field off the same snapshot, which
 * is what keeps the shell from holding a second copy of "what is this root"
 * (ADR 0035).
 *
 * The line and the label both come from whoever set the placeholder. This file
 * knows there is a string and a command id; it does not know what a task is, or
 * that `tasks.restore` exists — the rule ADR 0031 sets for a contributed row's
 * verbs, applied to a root.
 */
export interface ArchivedBannerProps {
  readonly placeholder: {
    readonly line: string;
    readonly action?: { readonly command: string; readonly label: string; readonly args?: unknown };
  };
  readonly onAction: (command: string, args: Readonly<Record<string, unknown>>) => void;
}

export function ArchivedBanner({ placeholder, onAction }: ArchivedBannerProps): ReactNode {
  const action = placeholder.action;
  return (
    <div className="sh-archived-banner" data-testid="archived-banner">
      <span className="sh-archived-banner-line">{placeholder.line}</span>
      {action === undefined ? null : (
        <button
          type="button"
          className="sh-archived-banner-action"
          onClick={() => {
            // `args` crossed a port as `unknown` and the invoke seam takes an
            // object. An absent one is `{}` rather than `undefined`, for the
            // reason the bridge already defaults it: every command's schema is
            // an `s.object`, and `s.object` on `undefined` is `invalid-args`.
            onAction(action.command, (action.args ?? {}) as Readonly<Record<string, unknown>>);
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
