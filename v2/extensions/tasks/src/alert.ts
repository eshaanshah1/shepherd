import type { AlertAction, AlertSpec } from '@shepherd/sdk';
import { TASK_COMMANDS } from './manifest.ts';

/**
 * The banner for one task, in this extension's own words.
 *
 * It exists because the shell's words were the only ones available and they say
 * nothing: `Turn finished` over an alert reason, four times, for four different
 * tasks. Everything below is a fact the rail already draws — the name, why it is
 * blocked, what it changed, the last thing the agent said — arriving at the one
 * surface that reaches you when Shepherd does not have the screen.
 *
 * **Pure.** The IO is the command handler's; this is a table, so the table is
 * testable and the failure modes above it are all one shape (an absent field).
 *
 * The faces it names (`agents`, `diff`) are slots view contributions already
 * declare, which is why naming them here is not this extension learning about
 * the shell: it is the same vocabulary a `face` contribution is registered with.
 */

export interface AlertStat {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

export interface AlertInput {
  readonly task: { readonly id: string; readonly title: string };
  /** The agent state, in the writer's vocabulary — `blocked`, not `waiting`. */
  readonly state: string;
  readonly reason?: string;
  readonly lastSaid?: string;
  readonly stat?: AlertStat;
}

/**
 * How much of a last line a banner can hold.
 *
 * macOS truncates the body itself, but it truncates it mid-word with no ellipsis
 * and its limit moves with the width of the notification; trimming here means
 * the sentence ends the same way every time and the `…` is honest about there
 * being more.
 */
const BODY_LIMIT = 160;

function trim(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_LIMIT ? flat : `${flat.slice(0, BODY_LIMIT - 1).trimEnd()}…`;
}

/** `3 files · +42 −7`, and `1 file` — a banner that says `1 files` reads as a bug. */
function statLine(stat: AlertStat): string {
  const files = `${stat.files} file${stat.files === 1 ? '' : 's'}`;
  return `${files} · +${stat.added} −${stat.removed}`;
}

/** The state, as a person would say it. The title is the task's name now. */
function subtitleOf(state: string): string {
  switch (state) {
    case 'blocked':
      return 'Waiting on you';
    case 'error':
      return 'Turn failed';
    default:
      return 'Turn finished';
  }
}

/** The last resort, so a banner is never titled with an empty second line. */
function stateWord(state: string): string {
  switch (state) {
    case 'blocked':
      return 'waiting on you';
    case 'error':
      return 'the turn failed';
    default:
      return 'finished a turn';
  }
}

/**
 * The second line, and the order is the point.
 *
 * **Blocked says why**, and never the last thing said: an agent that is asking
 * you something last SPOKE at the end of its previous turn, which is stale.
 *
 * **A finished turn says what changed**, because that is the thing you cannot
 * get from the state and the thing the decision in front of you rests on. With
 * nothing changed it falls back to the agent's own closing sentence — which is
 * dropped when it merely repeats the task's name, the rule the rail already
 * applies for the same measured reason (a short session's last record is often
 * the title Claude Code minted for it).
 */
function bodyOf(input: AlertInput, changed: boolean): string {
  if (input.state === 'blocked' || input.state === 'error') {
    return input.reason === undefined || input.reason.trim() === ''
      ? stateWord(input.state)
      : trim(input.reason);
  }
  if (changed && input.stat !== undefined) return statLine(input.stat);
  const said = input.lastSaid?.trim() ?? '';
  if (said === '' || said.toLowerCase() === input.task.title.trim().toLowerCase()) return stateWord(input.state);
  return trim(said);
}

export function alertFor(input: AlertInput): AlertSpec {
  const task = input.task.id;
  const changed = input.stat !== undefined && input.stat.files > 0;
  const blocked = input.state === 'blocked';
  const failed = input.state === 'error';

  /*
   * A finished turn with changes opens on what it CHANGED, everything else on
   * the agents — the same rule the shell applies to a clicked row
   * (`openingFace`), stated here because a banner knows the state and the shell
   * would have to re-derive it from a row that may not have arrived yet.
   */
  const face = changed && !blocked && !failed ? 'diff' : 'agents';

  const actions: readonly AlertAction[] = blocked
    ? [
        { label: 'Open', goto: { task, face: 'agents' } },
        /*
         * A concrete verb, not the rail's three-way `Later` menu: a banner has
         * no room for a menu, and "not now" with no "then" is the thing the
         * whole snooze feature exists to avoid.
         */
        { label: 'Later today', command: TASK_COMMANDS.snooze, args: { task, until: 'today' } },
      ]
    : failed
      ? [{ label: 'Open', goto: { task, face: 'agents' } }]
      : [
          { label: 'Diff', goto: { task, face: 'diff' } },
          { label: 'Agents', goto: { task, face: 'agents' } },
        ];

  return {
    title: input.task.title,
    subtitle: subtitleOf(input.state),
    body: bodyOf(input, changed),
    click: { task, face },
    actions,
  };
}
