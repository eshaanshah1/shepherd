import type { AttentionLevel } from '@shepherd/sdk';
import type { AgentState } from './state.ts';

/**
 * Agent state → the attention channel. The **only** place one becomes the other.
 *
 * They are two channels because they answer two questions. `AttentionLevel` has
 * no `working` and no `idle` — it says *how much the user is needed*, not what an
 * agent is doing — so driving the state indicator from it would be impossible and
 * driving the dock badge from agent state would put `working` on it.
 *
 * `agents-core` is the only writer of attention for agent sessions. v1's inverse
 * rule ("a nudge never writes `AgentState`") kept the hook lifecycle map
 * uncorrupted; this is that rule pointed the other way, and it is why
 * `claude-code`'s manifest deliberately does not declare `attention`.
 */

export interface AttentionForState {
  readonly level: AttentionLevel;
  readonly reason: string;
}

/**
 * The mapping, and the reasoning for each landing:
 *
 *   - `needsCheck` → **attention**. A finished turn you have not seen. Core
 *     clears exactly this level when you look at the pane, which is v1's
 *     "need-to-check → idle on focus" surviving with no second implementation.
 *   - `blocked`/`error` → **urgent**. Core deliberately does NOT clear `urgent`
 *     on a glance: looking at a permission prompt is not answering it.
 *   - everything else → **none**, which the store treats as a clear.
 *
 * The discriminator is the STATE, never the reason text — matching on a
 * human-facing string is v1's "detect by event, not by detail" bug one layer on.
 */
export function attentionFor(state: AgentState, reason: string | undefined): AttentionForState {
  const because = reason === undefined || reason === '' ? undefined : reason;
  switch (state) {
    case 'needsCheck':
      return { level: 'attention', reason: because ?? 'finished — you have not seen it yet' };
    case 'blocked':
      return { level: 'urgent', reason: because ?? 'waiting on you' };
    case 'error':
      return { level: 'urgent', reason: because ?? 'the turn ended on an error' };
    case 'shell':
    case 'idle':
    case 'working':
      return { level: 'none', reason: because ?? state };
  }
}
