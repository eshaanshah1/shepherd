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
  readonly className?: string;
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onNew,
  newIcon,
  newLabel = 'New tab',
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
  );
}
