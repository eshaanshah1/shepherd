import type { ReactElement, ReactNode } from 'react';
import { Menu, type MenuEntry } from '@shepherd/ui';

/**
 * Where this thread goes — the task's live agents, under the button that asked.
 *
 * ── a menu, not a modal ──────────────────────────────────────────────────────
 *
 * Three reasons, and the first is the one that decides it: **the verb acts on
 * one row, so the surface should point at that row.** A modal points at the
 * window. The second is that the thread you are handing over stays legible
 * behind a menu and a scrim destroys it — you are about to send somebody a
 * quote, and covering the quote is the wrong moment to do it. The third is that
 * two to four destinations do not need a search field.
 *
 * The escalation rule, when the list grows: at `MENU_MAX` destinations the last
 * item becomes `More…`, which opens the palette instead. A menu of nine agents
 * is a list you scan; a palette is a list you type into.
 *
 * ── what a row says ──────────────────────────────────────────────────────────
 *
 * `claude · sdk worktree` and then `sends now` or `queues`. The second half is
 * the part a plain destination list would omit and is the reason the rows carry
 * a state at all: an idle agent takes the prompt now, a mid-turn one takes it
 * when the turn ends, and finding that out by watching a pane not respond is
 * what this avoids. Both are fine, so neither is a warning.
 *
 * The mark is the app's own five-state one, so an agent reads the same here as
 * it does in the rail — a menu with its own vocabulary for "busy" would be a
 * second language for a fact the user already knows how to read.
 */

export interface AgentChoice {
  readonly session: string;
  readonly title: string;
  readonly cwd: string;
  readonly repo?: string;
  readonly role: 'orchestrator' | 'workstream';
  readonly mark: 'working' | 'waiting' | 'resting' | 'failed';
  readonly means: 'sends now' | 'queues';
}

/**
 * Beyond this many destinations the menu hands over to the palette.
 *
 * Five, because four is the most rows a person picks from by looking and the
 * fifth is where you start reading instead of recognising.
 */
export const MENU_MAX = 5;

/** The two ids that are not an agent. Namespaced so a session id cannot collide. */
export const HAND_NEW_AGENT = 'hand:new-agent';
export const HAND_COPY = 'hand:copy';
export const HAND_MORE = 'hand:more';

export function handMenuItems(choices: readonly AgentChoice[]): readonly MenuEntry[] {
  const shown = choices.length > MENU_MAX ? choices.slice(0, MENU_MAX - 1) : choices;

  return [
    ...shown.map(
      (choice): MenuEntry => ({
        id: choice.session,
        label: choice.title,
        mark: choice.mark,
        meta: choice.means,
      }),
    ),
    { separator: true },
    ...(choices.length > MENU_MAX
      ? [{ id: HAND_MORE, label: `More… (${choices.length})`, icon: undefined } satisfies MenuEntry]
      : []),
    {
      id: HAND_NEW_AGENT,
      label: 'New agent on this branch',
      icon: undefined,
      meta: 'opens a tab',
    },
    {
      id: HAND_COPY,
      label: 'Copy as prompt',
      icon: undefined,
      /*
       * DISPLAYED, not bound — `MenuItemSpec.shortcut` says so, and it is right
       * here: ⌘C while a menu is open is the menu's business, and the same
       * gesture with no menu open belongs to whatever has focus.
       */
      shortcut: '⌘C',
    },
  ];
}

/**
 * The button, with the menu hanging off it.
 *
 * The trigger is passed in rather than drawn here, because the caller owns which
 * button this is — the row's `Hand to agent`, or the footer's primary — and a
 * component that drew its own would make those two different buttons.
 */
export function HandMenu({
  choices,
  open,
  onOpenChange,
  onSelect,
  children,
}: {
  readonly choices: readonly AgentChoice[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (id: string) => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Menu trigger="click" items={handMenuItems(choices)} open={open} onOpenChange={onOpenChange} onSelect={onSelect}>
      {children}
    </Menu>
  );
}
