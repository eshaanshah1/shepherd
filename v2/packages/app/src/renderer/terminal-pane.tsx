import { useEffect, useRef, type ReactNode } from 'react';
import type { Pane } from '@shepherd/core/layout';
import type { PaneTerminals } from './pane-sessions.ts';

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
}

export function TerminalPane({ pane, terminals, focused }: TerminalPaneProps): ReactNode {
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

  return (
    <div className="sh-term" data-testid="terminal-host" data-pane-id={pane.id} ref={hostRef} />
  );
}
