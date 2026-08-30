import { useCallback, useMemo, type ReactElement } from 'react';
import type { ViewsApi } from '../../shared/index.ts';
import { resolveExtensionFaceUi } from '../extension-ui.ts';
import type { FaceTab } from './faces.ts';

/**
 * A face's body — the contributed component, mounted over the whole window.
 *
 * The same three refusals `ComponentView` and `ExtensionPane` make, because they
 * are what the in-proc seam IS (ADR 0033): the declared NAME resolves against a
 * static table, so a page never runs code the build did not see; `invoke` is
 * bound to THIS view type, so the component cannot name a caller and main
 * attributes every call to the extension that contributed it; and a name that
 * resolves to nothing draws an honest notice rather than an empty rectangle.
 *
 * What it does differently is the subject. A pane is handed the state it was
 * opened with; a face is handed the TASK the window is already showing, so
 * there is exactly one answer to "which task is this" and it is the router's.
 */

export interface FaceBodyProps {
  readonly tab: FaceTab;
  readonly task: { readonly id: string; readonly root: string };
  readonly bridge: ViewsApi | null;
}

export function FaceBody({ tab, task, bridge }: FaceBodyProps): ReactElement {
  const view = tab.view;
  const Component = resolveExtensionFaceUi(view?.component);

  /*
   * Stable across renders, for the reason `ExtensionPane`'s memo exists: a face
   * holds state (where you scrolled, which file is open) and asks for its data
   * on mount, and a fresh `invoke` identity would cancel those asks on every
   * parent render. The bill for getting this wrong is written up in
   * `extension-pane.tsx` and it was measured in the log, not modelled.
   */
  const type = view?.type;
  const invoke = useCallback(
    async (command: string, args?: unknown) => {
      if (bridge === null || type === undefined) {
        return { ok: false as const, error: { code: 'no-bridge', message: 'the page has no bridge' } };
      }
      return bridge.invoke(type, command, args);
    },
    [bridge, type],
  );

  /*
   * `done()` keeps its meaning and loses its effect: a face has nothing to
   * close. Ignored rather than refused, which is what a dock section already
   * does — a component should not have to know which surface it landed on in
   * order to be correct.
   */
  const props = useMemo(
    () => ({ task, invoke, done: () => undefined }),
    [task, invoke],
  );

  if (Component === undefined) {
    return (
      <div className="sh-face-note" data-testid="face-missing">
        {view === undefined
          ? 'Nothing claims this face.'
          : `This build has no component named “${view.component ?? view.type}”.`}
      </div>
    );
  }

  return (
    <div className="sh-face" data-testid="takeover-face" data-face={tab.face}>
      <Component {...props} />
    </div>
  );
}
