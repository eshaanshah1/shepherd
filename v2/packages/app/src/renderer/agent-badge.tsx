import type { ReactNode } from 'react';

/**
 * A pane's agent state, as one industrial micro-label beside a dot.
 *
 * Flock rule 8 makes the sheep the status system and keeps **plain dots as the
 * micro fallback**; this is that fallback, so the silhouette can land when the
 * art does without any of this wiring moving. Rule 5's uppercase micro-label
 * carries the word, and rule 9 fixes the height: attention changes what a row
 * *says*, never how big it is — v1 shipped a growing alert row and reverted it.
 *
 * **It renders at the same element position whether or not there is an agent**,
 * and only its *content* varies. Two reasons, and the first one is not the one
 * you might expect:
 *
 *   - It lets a smoke tell "this pane has no agent" from "the channel never
 *     delivered". Those are identical pixels and very different bugs, and an
 *     absent element cannot distinguish them.
 *   - The slot's height is a layout decision that belongs in CSS, not in the
 *     tree: rule 9 fixes row height so attention changes what a row says, never
 *     how big it is.
 *
 * **What it is NOT protection against, measured rather than assumed:** a
 * conditional *sibling* does not remount the terminal. React reconciles
 * `{cond && <Badge/>}` by keeping a placeholder at that index, so the host keeps
 * its position and its identity. An earlier version of this comment claimed
 * otherwise. The shapes that DO remount a sibling are a conditional **wrapper**
 * around it, and **positional keys** in a list whose length changes — both
 * pinned in `agent-badge.test.tsx`, with a control proving the bad shape really
 * does remount. That is the v1 `_ConditionalContent` bug class, and it is worth
 * knowing precisely rather than approximately: here it costs the xterm and its
 * scrollback (the session survives — the registry owns it), which is invisible
 * in review and shows up as a pane that lost its history.
 */

export interface AgentBadgeProps {
  /** Absent = a plain shell. The slot still renders, empty. */
  readonly state?: string;
  readonly reason?: string;
}

/**
 * The word on the label. Uppercased in CSS, not here — this is the content.
 *
 * There is deliberately no colour table beside it any more. There was one, and it
 * painted a `.sh-agent-dot` through an inline `style` — a call site naming
 * `var(--sh-cobalt)`, which is a tier-1 palette name and exactly the accidental
 * public API the token layer exists to retire. The dot it painted was
 * `display: none` in the only surface that renders this badge, so the fact was
 * encoded three times (border, text, an invisible dot) and drawn twice. The
 * colour is now the stylesheet's, keyed off `data-agent-state`, and the visible
 * micro-fallback dot is `StatusDot` — which takes a role and cannot name a hue.
 */
const LABEL: Readonly<Record<string, string>> = {
  working: 'working',
  blocked: 'blocked',
  needsCheck: 'done',
  error: 'error',
  idle: 'idle',
};

export function AgentBadge({ state, reason }: AgentBadgeProps): ReactNode {
  const known = state !== undefined && state !== 'shell' && state in LABEL;
  return (
    <div
      className="sh-agent-badge"
      data-testid="agent-badge"
      // Always present, and empty for a plain shell — so a smoke can tell
      // "no agent" from "the channel never delivered", which are the same
      // pixels and very different bugs.
      data-agent-state={known ? state : ''}
      title={reason ?? ''}
    >
      {known ? (
        <>
          <span className="sh-agent-label">{LABEL[state]}</span>
          {reason === undefined || reason === '' ? null : (
            <span className="sh-agent-reason">{reason}</span>
          )}
        </>
      ) : null}
    </div>
  );
}
