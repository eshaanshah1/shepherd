import { useEffect, useRef, type ReactNode } from 'react';
import { displayTitle, type Pane } from '@shepherd/core/layout';
import type { PaneTerminals } from './pane-sessions.ts';
import { AgentBadge } from './agent-badge.tsx';

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
  readonly agentReason?: string;
}

export function TerminalPane({
  pane,
  terminals,
  focused,
  agentState,
  agentReason,
}: TerminalPaneProps): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // Read the ref ONCE, here: by the time the cleanup runs, `paneRef.current`
    // may already be the pane that replaced this one, and detaching that id
    // would leave the old pane streaming and silence the new one.
    const attached = paneRef.current;
    terminals.attach(attached, host);
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

  return (
    // The host must never be wrapped conditionally, and this element must never
    // become a positionally-keyed list — those are the two shapes that remount a
    // sibling (measured; a conditional sibling does not). A remounted host is a
    // fresh xterm and lost scrollback. See `agent-badge.tsx`.
    //
    // The head is a STATIC element in the same slot the badge used to occupy, so
    // the terminal host keeps index 1 and its own identity for the life of the
    // pane. Nothing here may become `{cond && <div/>}` around the host.
    <div className="sh-pane" data-pane-id={pane.id}>
      <div className="sh-pane-head">
        <span className="sh-pane-name">{name}</span>
        {where === null ? null : <span className="sh-pane-branch">· {where}</span>}
        <AgentBadge
          {...(agentState === undefined ? {} : { state: agentState })}
          {...(agentReason === undefined ? {} : { reason: agentReason })}
        />
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
