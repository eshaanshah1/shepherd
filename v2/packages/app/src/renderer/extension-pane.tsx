import { useEffect, useMemo, useRef } from 'react';
import type { Pane } from '@shepherd/core/layout';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { resolveExtensionPaneUi } from './extension-ui.ts';

/**
 * A leaf that is a contributed view rather than a terminal (ADR 0044).
 *
 * The third surface an extension's UI can reach, after the dock section and the
 * overlay — and the first one that is a PLACE rather than chrome. `ComponentView`
 * is its sibling in `view-dock.tsx` and the two make the same three refusals: the
 * declared NAME resolves against a static table, `invoke` is bound to this view
 * type so the component cannot name a caller, and a name that resolves to nothing
 * draws an honest empty slot.
 *
 * Two things it does that its sibling does not, both because a pane is a place:
 *
 *   - **No head.** A terminal gets one because a grid of characters cannot say
 *     what it is; a view can, and a shell-drawn title over a view that titles
 *     itself is the repeated-name rule broken by the shell rather than by an
 *     extension. The view owns the whole rectangle.
 *   - **It knows whether it is focused**, because a pane binds keys and a
 *     background pane that answered them would fight the one you are looking at.
 *     Passed from the same snapshot the grid is drawn from (ADR 0035) rather than
 *     asked for here.
 *
 * What it deliberately does NOT do is touch `PaneTerminals`. A view pane never
 * reaches `attach`, so it never has a session — which is the whole enforcement,
 * and is why it is this component's existence rather than a flag inside
 * `TerminalPane` that keeps a pty from being spawned behind a PR list.
 */
export function ExtensionPane({
  pane,
  view,
  views,
  bridge,
  focused,
  onClose,
}: {
  readonly pane: Pane;
  /** The pane's own view ref — `type` plus whatever subject it names. */
  readonly view: { readonly type: string; readonly state?: unknown };
  /** Everything contributed right now, so `type` can be resolved to a component. */
  readonly views: readonly ViewContributionDTO[];
  readonly bridge: ViewsApi | null;
  readonly focused: boolean;
  /**
   * The component reported it is finished. For a pane, that means close it.
   *
   * Takes the pane's OWN id rather than closing over it, so one callback serves
   * every pane on the stage. A caller building `() => close(pane.id)` per row
   * cannot memoize it — the rows come out of a `map` and a hook cannot — so it
   * would be a fresh function on every render of the stage, which is the memo
   * below defeated from outside. See the note on that memo for what it cost.
   */
  readonly onClose: (paneId: string) => void;
}): React.JSX.Element {
  const contribution = views.find((candidate) => candidate.type === view.type);
  const Component = resolveExtensionPaneUi(contribution?.component);

  /*
   * Memoized on the identities that actually change, for `ComponentView`'s
   * reason one level up: a pane's component is long-lived and holds state (which
   * PR is open, where you scrolled), and fresh props on every parent render
   * would cancel the asks it made on mount, forever.
   *
   * **It was defeated from outside for months, and the bill was legible in the
   * log.** The stage passed `onDone={() => invoke(close, { pane: pane.id })}` —
   * an inline arrow, so a new identity on every render of the app — which put a
   * new identity on `invoke` here, which re-ran every effect in every pane keyed
   * on it. The review pane both refetched AND restarted its 3s poll on each one,
   * so a poll that should run 20 times a minute ran 162; each of those fanned out
   * to a `tasks.list`, an `agents.list` and a `layout.listRoots`; and the changes
   * pane's share was ten `git` spawns and one uncached GitHub request apiece. The
   * editor pane re-walked its repo the same way, 194 times in two minutes, and
   * the queue behind that is what made unrelated commands time out at ten
   * seconds. Every number here is off `app.log`, not a model.
   *
   * So the dependencies are load-bearing, and none of them may be a thing a
   * caller can hand over fresh. `onClose` is therefore held in a REF and is not
   * a dependency at all: it is read inside the click it belongs to and never
   * drawn, which is the same reason `review.tsx` keeps `asking` in one. Taking
   * the pane id rather than closing over it is what lets the stage keep a single
   * callback for every pane; the ref is what makes a stage that forgets to
   * cost nothing.
   */
  const closing = useRef(onClose);
  useEffect(() => {
    closing.current = onClose;
  }, [onClose]);

  const props = useMemo(
    () => ({
      state: view.state,
      focused,
      paneId: String(pane.id),
      invoke: async (command: string, args?: unknown) => {
        if (bridge === null) return { ok: false as const, error: { code: 'unavailable', message: 'no bridge' } };
        const result = await bridge.invoke(view.type, command, args);
        return result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: result.error };
      },
      done: () => closing.current(String(pane.id)),
    }),
    [bridge, view.type, view.state, focused, pane.id],
  );

  return (
    <div className="sh-pane sh-pane--view" data-pane-id={pane.id} data-view-type={view.type}>
      {Component === undefined ? (
        /*
         * Two different absences, one honest sentence each.
         *
         * A pane restored before its extension activates has no contribution yet
         * — which is ordinary, happens on every launch for a moment, and resolves
         * itself when the registration arrives and this re-renders. A
         * contribution whose component name this build does not have is the
         * version skew `EXTENSION_UI` documents, and it does not resolve itself.
         * Saying "loading" for the second would be a lie you wait on.
         */
        <p className="sh-pane-missing" data-testid="pane-view-missing">
          {contribution === undefined
            ? `Waiting for whoever draws “${view.type}”`
            : `${contribution.extension} contributed “${contribution.component ?? 'nothing'}”, which this build has no UI for`}
        </p>
      ) : (
        <Component {...props} />
      )}
    </div>
  );
}
