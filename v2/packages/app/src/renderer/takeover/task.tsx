import type { ReactElement } from 'react';
import { StateMark } from '@shepherd/ui';
import { TakeButton } from './home.tsx';
import type { FaceTab } from './faces.ts';
import type { Face } from './nav.ts';
import type { TriageEntry } from './triage.ts';

/**
 * **A task takes the window.**
 *
 * There is no tab strip and no rail here: entering a task means the window IS
 * the task, and the only chrome is one 48px band with the same hairline horizon
 * Home draws. The band says four things and offers two, and the order is the
 * reading order — how to leave, what state it is in, what it is called, how long
 * it has been going.
 *
 * **The body is the stage, untouched.** This component draws the band and
 * nothing else; the panes underneath are the app's real ones, still mounted,
 * still attached to their ptys. A second `SplitView` over the same panes would
 * either steal each terminal's element or spawn a second pty — the whole reason
 * the takeover moves the CHROME and leaves the stage where it is.
 *
 * **The verb on the right is the extension's.** A row declares a
 * `primaryAction` — ship it, restore it, whatever the thing it stands for is
 * ready for — and the band draws that. The shell has no idea what shipping is,
 * which is the same rule that keeps `tasks.reveal` out of this file. It does not
 * learn it by pressing, either: whether the press also ENDS this screen is the
 * row's own `leaves`, handed back to the caller unread.
 *
 * **The face tabs are the extension's too**, and one step further: the shell
 * does not even know which of them exist. `Agents` is always there because it
 * is the stage; every other tab is a slot an extension CLAIMED (ADR 0051), so a
 * build with no `github` has no Diff tab rather than a Diff tab that draws
 * nothing.
 */

export interface TakeoverTaskProps {
  /** The row this task stands for, or `null` while the trees are still arriving. */
  readonly entry: TriageEntry | null;
  /** A name to show before the first push lands, so the band is never blank. */
  readonly fallbackName: string;
  readonly onBack: () => void;
  readonly onAction: (action: {
    readonly id: string;
    readonly args?: unknown;
    /** The extension saying this verb ends the screen — see `TreeItem.primaryAction`. */
    readonly leaves?: boolean;
  }) => void;
  /** Only the faces something claims, in the order they are drawn. */
  readonly tabs: readonly FaceTab[];
  readonly face: Face;
  readonly onFace: (face: Face) => void;
  /** Put this one off — the `Later` verb, and the `S` key. */
  readonly onLater?: (() => void) | undefined;
}

export function TakeoverTask({
  entry,
  fallbackName,
  onBack,
  onAction,
  tabs,
  face,
  onFace,
  onLater,
}: TakeoverTaskProps): ReactElement {
  const primary = entry?.primaryAction;
  return (
    <header className="sh-take__head" data-testid="takeover-task">
      {/*
        The way out, drawn as the key rather than as a button with a chevron.
        It is a keyboard surface and `esc` is the gesture; a control here would
        be teaching the mouse a route the keyboard already owns — but it is
        clickable anyway, because §7's rule is that if you added a way in you
        add the way out AND the way to see it.
      */}
      <button type="button" className="sh-take__back" onClick={onBack} data-testid="takeover-back">
        <b>⌘[</b> back
      </button>
      <StateMark state={entry?.mark} />
      <span className="sh-take__tname">{entry?.label ?? fallbackName}</span>
      {/*
        Only if there is one. `0m` on a task that has not started is a number
        reporting that nothing has happened, which the absence says better.
      */}
      {entry?.facts.elapsed === undefined ? null : (
        <span className="sh-take__tel">{entry.facts.elapsed}</span>
      )}
      {/*
        One subject, seen four ways — which is why they are TABS and not places:
        `esc` from Diff leaves the task rather than going back to Agents. The
        number on each is a POSITION, so with no Diff tab `2` is Intent.
      */}
      <div className="sh-take__faces" role="tablist">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.face}
            className="sh-take__face"
            role="tab"
            aria-selected={tab.face === face}
            data-on={tab.face === face ? 'true' : undefined}
            data-testid="face-tab"
            data-face={tab.face}
            onClick={() => onFace(tab.face)}
          >
            {tab.label}
            <span className="sh-take__k">{tab.hint}</span>
          </button>
        ))}
      </div>
      <span className="sh-take__spacer" />
      {onLater === undefined ? null : (
        <TakeButton kind="ghost" hint="⌘L" data-testid="takeover-later" onClick={onLater}>
          Later
        </TakeButton>
      )}
      {primary === undefined ? null : (
        <TakeButton
          kind="primary"
          data-testid="takeover-primary"
          onClick={() =>
            onAction({ id: primary.id, args: primary.args, leaves: primary.leaves })
          }
        >
          {primary.label}
        </TakeButton>
      )}
    </header>
  );
}
