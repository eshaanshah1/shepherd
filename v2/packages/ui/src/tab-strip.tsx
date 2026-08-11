import type { ComponentType, ReactElement } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';
import { cn } from './cn.ts';
import { IconButton } from './icon-button.tsx';

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

export interface TabDescriptor {
  readonly id: string;
  readonly label: string;
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
