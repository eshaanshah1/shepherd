import type { ComponentType, ReactElement } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import { IconButton } from './icon-button.tsx';
import { StateMark, markSlot, type MarkState } from './state-mark.tsx';

/**
 * The tabs of ONE pane group.
 *
 * A primitive rather than markup in the shell, for the reason every control here
 * is one: a hand-rolled strip is where a hue gets typed in instead of a role
 * token, and the app's own tab strip and any contributed one have to be the same
 * object or they will drift into two.
 *
 * **It knows nothing about roots, tasks or commands.** It is handed labels and
 * hands back an id — which is what makes it usable by anything that has a set of
 * things and one of them showing, rather than by the layout alone.
 *
 * **`role="tablist"` and real `aria-selected`.** What this replaces in every
 * other codebase is a row of divs whose only state is a colour, and a tab a
 * screen reader cannot report as selected is a tab it cannot report at all.
 * There is deliberately no `tabpanel` wiring: the panel here is a pane tree
 * mounted somewhere else entirely, and an `aria-controls` pointing at an element
 * this component cannot see would be a claim rather than a relationship.
 *
 * **Selection is derived, never held.** `activeId` comes from whatever owns the
 * group; an id naming no tab selects nothing, which is the honest answer in the
 * instant after a tab closes and before the next snapshot lands.
 */

/**
 * What a tab SAYS, when there is an agent in it.
 *
 * `StateMark`'s vocabulary and not the agent lifecycle's, for the reason that
 * primitive gives: a primitive does not know what a session is. `blocked` and
 * `needsCheck` are Claude Code's words and stay on the app's side of the
 * boundary; `waiting` and `ready` are things anything can be.
 *
 * A tab with no agent — a plain shell, a contributed view — draws no mark but
 * KEEPS the slot (`markSlot`). Two rules meet there and both survive: a ring on
 * a pull-request tab would claim a lifecycle it has not got, and a tab that grew
 * by the mark's width when its agent started would slide every tab to its right
 * along — which is §10's control that moves under the cursor, on the one gesture
 * (spawning an agent) that makes it happen.
 */

export interface TabDescriptor {
  readonly id: string;
  readonly label: string;
  /** The rollup over the agents in this tab. Absent = no agent = an empty slot. */
  readonly mark?: MarkState;
  /**
   * What this tab IS, when it has no state to be in — a pull request, a diff.
   *
   * A component and never a name, which is `Icon`'s rule: a primitive that
   * resolved a string would have to hold the table, and the table is the
   * renderer's allow-list.
   *
   * It shares the mark's slot and LOSES to it, so a split holding an agent and a
   * view reports the agent. Identity is what a tab falls back to once there is
   * no state to report; a glyph that displaced a blocked square would hide the
   * one thing in the strip you can act on.
   */
  readonly icon?: ComponentType<TablerIconProps>;
}

/**
 * What the focused pane is offering, drawn at the trailing edge.
 *
 * The strip is furniture and the tabs are the nouns on it, so an action here is
 * `secondary` and never `primary`: one wool fill beside three tabs would be the
 * loudest thing in the window, and the one primary belongs to whatever the action
 * opens.
 *
 * **A glyph, never a name** — `Icon`'s rule. The names an extension sends are the
 * renderer's to resolve through its own allow-list before they reach here.
 *
 * One flat button and no chevron: the split control was drawn and then dropped,
 * because a menu here would need the SHELL to invoke a command and read choices
 * back, and `api-layout.ts` records why one caller does not pay for that.
 */
export interface TabAction {
  /** Handed back to `onAction`. For a contributed action this is its own id. */
  readonly id: string;
  /** 1–3 words, sentence case. */
  readonly label: string;
  readonly glyph: ComponentType<TablerIconProps>;
}

export interface TabStripProps {
  readonly tabs: readonly TabDescriptor[];
  /** Which one is showing. An id naming no tab selects none. */
  readonly activeId: string;
  /** Answers with the tab's ID, never its index — a reorder must not rename it. */
  readonly onSelect: (id: string) => void;
  /**
   * Absent = no new-tab control.
   *
   * A strip with nowhere to send the gesture must not draw a button for it —
   * the alternative is a `+` that does nothing, which teaches that the strip is
   * broken rather than that this one has no such verb.
   */
  readonly onNew?: () => void;
  /** Required WITH `onNew`, for `IconButton`'s reason: an icon alone names nothing. */
  readonly newIcon?: ComponentType<TablerIconProps>;
  readonly newLabel?: string;
  /**
   * What the focused pane offers. Empty is the resting state and the common one.
   *
   * They draw BEFORE `__new`, which is the ordering every window chrome uses: the
   * things you act on, then the chrome's own verb. The `+` also stays pinned to
   * the edge whatever arrives beside it, so a control does not walk sideways as a
   * pane starts and stops offering things.
   */
  readonly actions?: readonly TabAction[];
  /** Answers with the action's id. What it does is the caller's business. */
  readonly onAction?: (id: string) => void;
  readonly className?: string;
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onNew,
  newIcon,
  newLabel = 'New tab',
  actions = [],
  onAction,
  className,
}: TabStripProps): ReactElement {
  return (
    <div className={cn('sh-ui-tabs', className)} role="tablist" data-testid="tab-strip">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="sh-ui-tab"
          aria-selected={tab.id === activeId}
          data-active={tab.id === activeId}
          data-tab-id={tab.id}
          onClick={() => onSelect(tab.id)}
        >
          {tab.mark !== undefined ? (
            <StateMark state={tab.mark} />
          ) : (
            /*
              `markSlot` rather than a box of this strip's own: the 12px is
              declared once, beside the mark, and a second literal here would
              drift the moment a mark changed size.
            */
            <span className={markSlot} aria-hidden="true">
              {tab.icon === undefined ? null : <Icon icon={tab.icon} size="sm" />}
            </span>
          )}
          <span className="sh-ui-tab__label">{tab.label}</span>
        </button>
      ))}
      {/*
        The trailing group, which exists whenever EITHER half does — one element
        holding the auto margin, so the `+` does not move sideways as actions
        arrive and leave. That is the same reason `__new` was pinned in the first
        place, applied one level out.
      */}
      {actions.length === 0 && (onNew === undefined || newIcon === undefined) ? null : (
        <div className="sh-ui-tabs__trailing">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="sh-ui-tabs__action"
              data-testid={`tab-action-${action.id}`}
              onClick={() => onAction?.(action.id)}
            >
              <Icon icon={action.glyph} size="sm" />
              <span>{action.label}</span>
            </button>
          ))}
          {onNew === undefined || newIcon === undefined ? null : (
            <IconButton
              icon={newIcon}
              size="sm"
              label={newLabel}
              className="sh-ui-tabs__new"
              data-testid="tab-new"
              onClick={onNew}
            />
          )}
        </div>
      )}
    </div>
  );
}
