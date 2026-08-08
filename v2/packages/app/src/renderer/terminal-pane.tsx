import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { displayTitle, type Pane } from '@shepherd/core/layout';
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
}

export function TerminalPane({
  pane,
  terminals,
  focused,
  agentState,
  agentReason,
  sessionId,
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
    // `sessionRef`, not `sessionId`: this effect must not re-run when the
    // binding arrives, or a pane would detach and re-attach the moment its
    // session is created. The value is only READ at mount, which is exactly
    // when adoption matters.
    terminals.attach(attached, host, sessionRef.current);
    return () => terminals.detach(attached.id);
  }, [pane.id, terminals]);

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

  const name = displayTitle(pane, '');
  // The dim tail, only when it would say something the name does not. A pane
  // with no title of its own already *is* its cwd (see `displayTitle`), and
  // printing the path twice is noise dressed as detail.
  const named = (pane.userTitle ?? '') !== '' || pane.title !== '';
  const where = named ? pathTail(pane.cwd) : null;

  /*
   * The pane head is painted on the GRID's background, not on `--sh-ink`, so the
   * pane and the terminal inside it read as one surface — the strip stops being a
   * lid on a window into another program. The seam is then the hairline alone.
   *
   * Two things follow, and both are the point (reference notes, takeaway 8):
   *
   *   - the background travels as a custom property rather than a class, so the
   *     bar and the grid cannot be painted with different colours; and
   *   - the FOREGROUND set is chosen from that colour's measured luminance,
   *     published as `data-pane-title-surface`. Never from the app's theme mode:
   *     a light terminal palette inside a dark app would leave the head drawing
   *     near-white text on near-white ground, and it would fail silently, only
   *     for users who themed something.
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
    // The head is a STATIC element in the same slot the badge used to occupy, so
    // the terminal host keeps index 1 and its own identity for the life of the
    // pane. Nothing here may become `{cond && <div/>}` around the host.
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
      data-pane-title-surface={surface}
      style={style}
    >
      <div className="sh-pane-head" data-testid="pane-head">
        <span className="sh-pane-name">{name}</span>
        {where === null ? null : <span className="sh-pane-branch">· {where}</span>}
      </div>
      <div className="sh-term" data-testid="terminal-host" data-pane-id={pane.id} ref={hostRef} />
    </div>
  );
}

/**
 * The last two components of a path. Presentation only — a full absolute path in
 * a 28px strip is a line of ellipsis, and the pane's identity is the leaf.
 */
function pathTail(cwd: string | null): string | null {
  if (cwd === null || cwd === '') return null;
  const parts = cwd.split('/').filter((part) => part !== '');
  return parts.length === 0 ? '/' : parts.slice(-2).join('/');
}
