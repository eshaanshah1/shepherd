import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { type Pane } from '@shepherd/core/layout';
import { paneTitleSurface } from '@shepherd/design-tokens';
import type { PaneTerminals } from './pane-sessions.ts';
import { terminalBackground } from './theme.ts';

/**
 * One leaf's view. It owns a `<div>` and nothing else.
 *
 * The effect's dependency list is `[pane.id, terminals]` on purpose, and the
 * live pane is read through a ref: depending on `pane` would re-run attach on
 * every OSC title change, and re-running attach is exactly the shape of the v1
 * defect this phase exists to prevent — a remount that takes a PTY with it.
 * Here it would not even kill anything (the registry owns the session), but it
 * would still throw away the terminal for a title.
 *
 * The cleanup calls `detach`, never `close`. There is no path from unmounting
 * to a dead session; see `pane-sessions.ts`.
 */

export interface TerminalPaneProps {
  readonly pane: Pane;
  readonly terminals: PaneTerminals;
  readonly focused: boolean;
  /** This pane's agent state, if it has one. Absent = a plain shell. */
  readonly agentState?: string;
  /**
   * The session the LAYOUT says is on this pane, if any. Handed to `attach` so
   * a reloaded page adopts it rather than creating a second one.
   */
  readonly sessionId?: string;
  readonly agentReason?: string;
  /**
   * The colour THIS pane's grid is painted with, `#RRGGBB`.
   *
   * A prop rather than a theme lookup because it is per-pane by construction: an
   * extension may theme one terminal and not its neighbour, and the head has to
   * follow the pane it belongs to. Absent = the app's own terminal background.
   */
  readonly background?: string;
  /**
   * Whether this pane's root is the one the window is showing.
   *
   * Every root stays MOUNTED (hidden ones with `display: none`), because a
   * conditional mount tears the subtree down and a torn-down pane is v1's
   * remount lesson. So "not visible" cannot be expressed by not rendering — it
   * is expressed here, and it means the pane holds no terminal and receives no
   * bytes until its root comes back.
   */
  readonly visible?: boolean;
}

export function TerminalPane({
  pane,
  terminals,
  focused,
  agentState,
  agentReason,
  sessionId,
  visible = true,
  background = terminalBackground(),
}: TerminalPaneProps): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // Read the ref ONCE, here: by the time the cleanup runs, `paneRef.current`
    // may already be the pane that replaced this one, and detaching that id
    // would leave the old pane streaming and silence the new one.
    const attached = paneRef.current;

    // A pane in a root nobody is looking at holds no terminal. `suspend` is not
    // `detach`: it drops the view and the stream and keeps the session, which is
    // only safe because the host now holds the SCREEN — before R0 a pane that
    // stopped listening could never catch up. See `pane-sessions.ts`.
    if (!visible) {
      terminals.suspend(attached, sessionRef.current);
      return;
    }

    // `sessionRef`, not `sessionId`: this effect must not re-run when the
    // binding arrives, or a pane would detach and re-attach the moment its
    // session is created. The value is only READ at mount, which is exactly
    // when adoption matters.
    terminals.attach(attached, host, sessionRef.current);
    return () => terminals.detach(attached.id);
  }, [pane.id, terminals, visible]);

  useEffect(() => {
    if (focused) terminals.focus(pane.id);
  }, [focused, pane.id, terminals]);

  // Re-fit on any size change, including the ones a divider drag causes.
  // ResizeObserver is guarded because jsdom has none, and a lifecycle test must
  // not need a polyfill to say what it is about.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => terminals.fit(pane.id));
    observer.observe(host);
    return () => observer.disconnect();
  }, [pane.id, terminals]);

  /*
   * The pane no longer draws a head.
   *
   * It was a 28px strip naming the pane and its cwd, and it was the app's THIRD
   * row of chrome: the tab strip already names the root, the sidebar already
   * names the task, and a single-pane task therefore read its own name twice in
   * two bars stacked on each other. §10's rule — nothing repeats a name down the
   * hierarchy — and the tab strip is now permanent, so the name has a place.
   *
   * The grid's own colour is still published here, and both halves still matter:
   *
   *   - the background travels as a custom property rather than a class, so the
   *     pane's padding and the grid cannot be painted with different colours; and
   *   - the FOREGROUND set is still chosen from that colour's measured luminance,
   *     published as `data-pane-title-surface`, so anything mounted INSIDE a pane
   *     later adopts the terminal's palette rather than the app's. Never from the
   *     app's theme mode: a light terminal palette inside a dark app would leave
   *     it drawing near-white text on near-white ground, and it would fail
   *     silently, only for users who themed something.
   */
  const surface = paneTitleSurface(background);
  // `CSSProperties & Record<string, string>` is how a custom property gets past
  // the type: `CSSProperties` has no index signature, and a cast would also
  // silence a real typo in one of the known keys.
  const style: CSSProperties & Record<string, string> = { '--sh-pane-title-bg': background };

  return (
    // The host must never be wrapped conditionally, and this element must never
    // become a positionally-keyed list — those are the two shapes that remount a
    // sibling (measured; a conditional sibling does not). A remounted host is a
    // fresh xterm and lost scrollback. See `agent-badge.tsx`.
    //
    // The host is the pane's ONLY child now that the head is gone — which is
    // still a static shape, and that is the invariant: nothing here may become
    // `{cond && <div/>}` around the host.
    <div
      className="sh-pane"
      data-pane-id={pane.id}
      /*
       * The agent's state as DATA and nothing else.
       *
       * There was a chip here reading "working" / "blocked" / "idle". It is
       * gone: the sidebar's dot already carries the state, and a second copy on
       * the surface you are looking at is the app telling you what you can see.
       * The attribute stays because the state still has to reach something —
       * the smoke reads it to prove the hook→bus→renderer chain is live, and a
       * future indicator will read it too.
       */
      data-agent-state={agentState ?? ''}
      /*
       * This pane shows a captured screen and will never have a session.
       *
       * As DATA for the same reason the agent state is: the smoke reads it to
       * prove that revealing shelved work put a snapshot on screen rather than
       * a live shell, which is a claim no unit test can make about the real app.
       */
      data-readonly={pane.readOnly ? 'true' : ''}
      data-pane-title-surface={surface}
      style={style}
    >
      <div className="sh-term" data-testid="terminal-host" data-pane-id={pane.id} ref={hostRef} />
    </div>
  );
}
