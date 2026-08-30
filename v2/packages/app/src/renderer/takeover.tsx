import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { TakeoverHome } from './takeover/home.tsx';
import { TakeoverTask } from './takeover/task.tsx';
import { Switcher } from './takeover/switcher.tsx';
import { FaceBody } from './takeover/face-body.tsx';
import { LaterMenu } from './takeover/later.tsx';
import { faceForKey, faceTabs, nearestFace } from './takeover/faces.ts';
import type { PlaceItem } from './takeover/places.ts';
import type { Face } from './takeover/nav.ts';
import { useTriageEntries } from './takeover/entries.ts';
import {
  HOME,
  currentTask,
  go,
  home,
  jump,
  openingFace,
  pop,
  withFace,
  type Nav,
  type Place,
} from './takeover/nav.ts';
import { needsYou, nextNeeding, type TriageEntry } from './takeover/triage.ts';
import type { RowAnswer } from './takeover/row-facts.ts';
import './takeover.css';

/**
 * **The takeover — the window as an attention router.**
 *
 * v2 shipped as rail + stage: a list of everything on the left, always, and
 * whatever you were doing on the right. That shape answers "what exists". The
 * question you actually have twenty times a day is "what needs me", and a
 * permanent list cannot answer it — it draws the eight things that do not need
 * you in the same ink as the one that does.
 *
 * So the window is one thing at a time. Home is a triage screen; a task is the
 * whole window; and between them there is a stack, so `esc` is a real answer
 * rather than "go to Home".
 *
 * **Its chrome is IN THE APP'S COLUMN, not on top of it.**
 *
 * The band began life as a `position: fixed` layer, and every surface that laid
 * out under it collided with it differently — the composer opened behind it, the
 * terminal's first line was clipped under it, the `Ship` button ran off the
 * right edge. Each was patched on its own: hide the rail, pad the stage, make
 * the plate opaque. That is three fixes for one fault, and the fault is that a
 * fixed layer is not part of the layout it is sitting in.
 *
 * So this is a HOOK rather than a component. `app.tsx` composes the window and
 * puts the band where `.sh-plate` would have gone — a real flex child of
 * `.sh-app`, above `.sh-body`. The body then flows beneath it the way a body
 * flows beneath a title bar: no `position: fixed`, no `padding` compensation, no
 * z-index negotiation, and nothing inside the stage can be measured against the
 * wrong height. `Home` stays a full-window layer because it genuinely covers
 * everything, which is the one case an overlay is honest about.
 *
 * **The roots never move.** This re-parents CHROME. Every root stays mounted
 * with its ptys attached, which is `_ConditionalContent`'s lesson: a torn-down
 * pane is a released terminal and then, on the way back, a second pty.
 */

export interface TakeoverProps {
  readonly views: ViewsApi | null;
  /**
   * Everything contributed right now — the list the face tabs are computed
   * from. Handed in rather than read here, because `app.tsx` already holds it
   * for the dock and two subscriptions to one list is two answers to one
   * question.
   */
  readonly contributions: readonly ViewContributionDTO[];
  /** The layout's own answer for which group a root is a tab of. */
  readonly groupOfRoot: (root: string) => string;
  /** The one funnel every gesture goes through. */
  readonly invoke: (command: string, args: Readonly<Record<string, unknown>>) => void;
  /** Raise a contributed screen by its view type — how `New` opens the composer. */
  readonly onRaiseView: (type: string) => void;
  /** True while another layer owns the window, so this one stops listening. */
  readonly suspended?: boolean;
}

/**
 * The pieces the window is assembled from, in the order they are laid out.
 *
 * Returned rather than rendered because two of them belong in different places
 * in `app.tsx`'s column, and a component that returned all three would have to
 * be positioned — which is the thing this shape exists to stop.
 */
export interface TakeoverSurfaces {
  /**
   * The chrome band, as a flex child of `.sh-app` — where `.sh-plate` sits when
   * there is no takeover. `null` on Home, which draws its own header inside a
   * layer that covers the window anyway.
   */
  readonly band: ReactElement | null;
  /**
   * The contributed document a face draws, as the column's CONTENT — a flex
   * sibling under the band, in the place `.sh-body` occupies.
   *
   * Separate from `band` because they are different slots, not one block that
   * happens to have chrome at the top: the band is `flex: none` and the face
   * takes everything left. Fusing them was the first version of this and it put
   * a document inside the chrome slot, where it had no height at all.
   *
   * `null` on the `agents` face, and that is the whole of what "Agents is the
   * stage" means: nothing is drawn here, `.sh-body` stays visible, and the real
   * panes keep the room.
   */
  readonly face: ReactElement | null;
  /** The triage screen: a real full-window layer, over everything. */
  readonly home: ReactElement | null;
  /** The switcher and the Later menu — fixed, and always last. */
  readonly overlays: ReactElement;
  /**
   * What the window is showing, for the shell's own composition: with a place,
   * `app.tsx` draws no rail, no tab strip and no plate, because this replaced
   * all three. `null` while another layer owns the window.
   */
  readonly place: 'home' | 'task' | 'shells' | null;
}

export function useTakeover({
  views,
  contributions,
  groupOfRoot,
  invoke,
  onRaiseView,
  suspended = false,
}: TakeoverProps): TakeoverSurfaces {
  const { entries, more } = useTriageEntries({ bridge: views, groupOfRoot });
  const [nav, setNav] = useState<Nav>(HOME);
  const [switching, setSwitching] = useState(false);
  /** The entry whose `Later` menu is open, by id. */
  const [deferring, setDeferring] = useState<string | null>(null);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  /** Agents, plus one tab per slot an extension claimed (ADR 0051). */
  const tabs = useMemo(() => faceTabs(contributions), [contributions]);

  /**
   * Open what a row stands for: run the row's own verb, and move the window.
   *
   * The verb is the EXTENSION's — `tasks.reveal` opens the worktree's root and
   * switches to it — and the shell does not know what it does. What the shell
   * knows is where it just went, which is the half a command cannot tell it: a
   * navigation stack is the page's own state, and a row that could push onto it
   * would be an extension deciding what `esc` means.
   */
  const open = useCallback(
    (entry: TriageEntry, how: 'push' | 'jump' = 'push') => {
      const arrive = how === 'jump' ? jump : go;
      if (entry.command !== undefined) {
        invoke(entry.command.id, (entry.command.args ?? {}) as Readonly<Record<string, unknown>>);
      }
      if (entry.place) {
        setNav((current) => arrive(current, { kind: 'shells' }));
        return;
      }
      if (entry.root === undefined) return;
      /*
       * A finished task opens on what it CHANGED rather than on a terminal with
       * no agent in it — and `nearestFace` is the other half: with nothing
       * claiming `diff`, that lands on the agents instead of on a blank tab.
       */
      const face = nearestFace(
        tabs,
        openingFace({ running: entry.mark === 'working', changed: entry.facts.diff !== undefined }),
      );
      setNav((current) => arrive(current, { kind: 'task', id: entry.id, root: entry.root as string, face }));
    },
    [invoke, tabs],
  );

  /**
   * Answer a question from Home, WITHOUT opening the task.
   *
   * The whole reason a question is a card rather than a row: the answer is two
   * words and you already have them, so making you enter the task to say them
   * is the interruption the screen exists to remove.
   */
  const answer = useCallback(
    (_entry: TriageEntry, chosen: RowAnswer) => {
      invoke(chosen.command, (chosen.args ?? {}) as Readonly<Record<string, unknown>>);
    },
    [invoke],
  );

  /**
   * Open a task straight at one of its faces.
   *
   * `open` decides the face for you — Agents, or Diff when the work is done —
   * which is right for clicking a row. This is the other half: the row's own
   * shortcuts, where the point is that you already know you want the changes.
   * It runs the row's verb the same way, because the worktree still has to be
   * on screen underneath whichever face you land on.
   */
  const openAt = useCallback(
    (entry: TriageEntry, face: Face) => {
      if (entry.command !== undefined) {
        invoke(entry.command.id, (entry.command.args ?? {}) as Readonly<Record<string, unknown>>);
      }
      if (entry.root === undefined) return;
      setNav((current) => go(current, { kind: 'task', id: entry.id, root: entry.root as string, face }));
    },
    [invoke],
  );

  const raiseComposer = useCallback(() => {
    onRaiseView(COMPOSER_VIEW);
  }, [onRaiseView]);

  /**
   * Put one off. The menu is opened, never the verb run — the WHEN is the useful
   * half, and a `Later` that always meant the same delay would be a mute button
   * on the one screen that exists to say what needs you.
   *
   * A row that publishes no options has no `Later` at all: the control is absent
   * rather than present and inert.
   */
  const later = useCallback((entry: TriageEntry) => {
    if (entry.facts.later === undefined) return;
    setDeferring(entry.id);
  }, []);

  const defer = useCallback(
    (entry: TriageEntry, option: RowAnswer) => {
      setDeferring(null);
      invoke(option.command, (option.args ?? {}) as Readonly<Record<string, unknown>>);
      /*
       * And leave the task, if you were in it. Deferring from inside something
       * is a way of saying "not this" — staying put would leave you looking at
       * the one thing you just said you did not want to look at.
       */
      setNav((current) => (currentTask(current)?.id === entry.id ? pop(current) : current));
    },
    [invoke],
  );

  /** ⌘K's answer: one of the three standing places, or a task. */
  const pick = useCallback(
    (item: PlaceItem) => {
      setSwitching(false);
      if (item.kind === 'home') {
        setNav(home());
        return;
      }
      if (item.kind === 'new') {
        raiseComposer();
        return;
      }
      if (item.kind === 'shells') {
        setNav((current) => jump(current, { kind: 'shells' }));
        return;
      }
      if (item.entry !== undefined) open(item.entry, 'jump');
    },
    [open, raiseComposer],
  );

  /*
   * The keyboard.
   *
   * CAPTURE phase on the window, which is the same reason ⌘K and the find bar
   * use it: an xterm almost always has focus and handles `keydown` on the way
   * DOWN, so anything bubbling arrives after the pty has already been written
   * to.
   *
   * **What protects the single-letter keys is the TARGET, not the place.** A
   * global `j` would otherwise delete the letter j from every terminal in the
   * app — but a focused xterm receives keystrokes through a real
   * `<textarea>` (its helper element), so the same check that keeps these keys
   * out of a text field keeps them out of the grid. That is one rule instead of
   * two, and it is the rule that stays correct when a task's pane is a
   * contributed view rather than a terminal.
   *
   * It matters that this is not gated on which screen is up: `J` means "the next
   * one that needs me", and its whole value is pressing it again from the task
   * it just took you to.
   */
  useEffect(() => {
    if (suspended) return;
    const onKey = (event: KeyboardEvent): void => {
      /*
       * ⌘K, and it toggles. The palette moved to ⌘⇧P when this took the key:
       * the two lists answer different questions (where am I going / what can I
       * run) and the one people reach for twenty times a session is this one.
       */
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        setSwitching((open_) => !open_);
        return;
      }
      /*
       * Escape still DISMISSES — a menu, the switcher — because that is what it
       * means everywhere. It no longer NAVIGATES.
       *
       * Going back was `Escape` and that was wrong: the thing under this layer
       * is a terminal, and Escape belongs to whatever is running in it. Vim
       * leaves insert mode with it, an agent interrupts its turn with it, a
       * pager closes with it. A key the window steals from the program the
       * window exists to show is a key that breaks the program.
       *
       * `⌘[` is the platform's own back — Finder, Safari, every document app —
       * and no terminal program can claim a Command chord.
       */
      if (event.key === 'Escape') {
        if (deferring !== null) {
          event.preventDefault();
          event.stopPropagation();
          setDeferring(null);
          return;
        }
        if (switching) {
          event.preventDefault();
          event.stopPropagation();
          setSwitching(false);
          return;
        }
        return;
      }
      /*
       * The chords that have to work WHILE A TERMINAL HAS FOCUS.
       *
       * Everything below the guard further down is a bare key, and a bare key is
       * the pty's the moment an xterm has the keyboard — which on the `Agents`
       * face is nearly always. So the two gestures that belong to a task you are
       * watching an agent work in take a modifier: switching face, and putting
       * the task off. It is the rule this app already enforces on every
       * contributed accelerator (`hasModifier`), applied to its own chrome, and
       * the band prints exactly these.
       */
      if ((event.metaKey || event.ctrlKey) && !event.altKey && nav.at.kind === 'task') {
        const wanted = faceForKey(tabs, event.key);
        if (wanted !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          setNav((current) => withFace(current, wanted));
          return;
        }
        if (event.key.toLowerCase() === 'l') {
          const subject = byId.get(currentTask(nav)?.id ?? '');
          if (subject?.facts.later !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            later(subject);
            return;
          }
        }
      }
      if (event.key === '[' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        // Never while another layer is up: the composer and the palette are
        // strictly in front of this and own their own dismissal.
        if (document.querySelector('[data-testid="view-screen"]') !== null) return;
        if (nav.at.kind === 'home') return;
        event.preventDefault();
        event.stopPropagation();
        setNav(pop);
        return;
      }
      // The switcher and the Later menu own every keystroke while they are up:
      // their own handlers read the digits and the arrows.
      if (switching || deferring !== null || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true) {
        return;
      }
      const key = event.key.toLowerCase();
      /*
       * The answer keys, and they BEAT `N`-for-new while a question is on screen.
       *
       * The clash is real and the prototype loses it: `N` composes there, so the
       * `N` printed on every "Deny" button never fires. The resolution follows
       * the screen's own hierarchy — `Needs you` is the one region drawn loud,
       * and a question with its verbs in front of you is the reason you are
       * looking at it. With nothing asking, `N` is the new task again.
       *
       * The keys are the EXTENSION's: they come off the answer it published, so
       * a verb pair that is not Y/N binds whatever it says it binds.
       */
      const asking = needsYou(entries).find((each) => each.facts.question?.answers !== undefined);
      const chosen = asking?.facts.question?.answers?.find(
        (candidate) => candidate.key?.toLowerCase() === key,
      );
      if (asking !== undefined && chosen !== undefined) {
        event.preventDefault();
        answer(asking, chosen);
        return;
      }
      /*
       * `S` — put off whatever is in front of you: the task you are in, or the
       * loud card on Home. It opens the menu; nothing is deferred by one press.
       */
      if (key === 's') {
        const subject =
          currentTask(nav) !== null
            ? (byId.get(currentTask(nav)?.id ?? '') ?? null)
            : (needsYou(entries)[0] ?? null);
        if (subject?.facts.later !== undefined) {
          event.preventDefault();
          later(subject);
          return;
        }
      }
      if (key === 'h') {
        event.preventDefault();
        setNav(home());
        return;
      }
      if (key === 'j') {
        event.preventDefault();
        const current = currentTask(nav);
        const next = nextNeeding(entries, current?.id);
        if (next !== undefined) open(next);
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        raiseComposer();
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        setNav((current) => go(current, { kind: 'shells' } satisfies Place));
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [suspended, switching, deferring, nav, tabs, entries, byId, open, answer, later, raiseComposer]);

  const task = currentTask(nav);
  const deferred = deferring === null ? null : (byId.get(deferring) ?? null);

  const overlays = (
    <>
      {switching ? <Switcher entries={entries} onPick={pick} onClose={() => setSwitching(false)} /> : null}
      {deferred === null || deferred.facts.later === undefined ? null : (
        <LaterMenu
          name={deferred.label}
          later={deferred.facts.later}
          onPick={(option) => defer(deferred, option)}
          onClose={() => setDeferring(null)}
        />
      )}
    </>
  );

  if (suspended) return { band: null, face: null, home: null, overlays: <></>, place: null };

  /*
   * SHELLS gets a band like every other place.
   *
   * It used to render nothing at all — which left two bare terminals with the
   * traffic lights sitting on the first one's prompt, no name for where you
   * were, and no way back but a shortcut you had to already know. A screen with
   * no chrome is not minimal, it is unlabelled.
   *
   * The body under it is the STAGE, drawing the real panes: the shells are panes
   * exactly as an agent's terminal is, and the band is a sibling above them
   * rather than a lid over them.
   */
  if (nav.at.kind === 'shells') {
    return {
      place: 'shells',
      face: null,
      home: null,
      overlays,
      band: (
        <header className="sh-take__head" data-testid="takeover-shells" data-place="shells">
          <button
            type="button"
            className="sh-take__back"
            onClick={() => setNav(pop)}
            data-testid="takeover-back"
          >
            <b>⌘[</b> back
          </button>
          <span className="sh-take__tname">Shells</span>
        </header>
      ),
    };
  }

  if (task !== null) {
    const tab = tabs.find((each) => each.face === task.face);
    return {
      place: 'task',
      home: null,
      overlays,
      band: (
          <TakeoverTask
            entry={byId.get(task.id) ?? null}
            fallbackName={task.root}
            onBack={() => setNav(pop)}
            onAction={(action) => {
              invoke(action.id, (action.args ?? {}) as Readonly<Record<string, unknown>>);
              /*
               * And leave, when the row says the verb ends this screen.
               *
               * Ship closes the task's panes and Unship tears the snapshot down
               * to rebuild it, so staying put means watching the window you are
               * in be dismantled — with no stage left, and a band naming a task
               * that has moved to another region of the overview. The work goes
               * on behind the row's own busy mark, which is where progress
               * belongs; the gesture is over the moment it is made.
               *
               * `pop` rather than `home()`, the same move `defer` makes: it is
               * the way OUT of this screen, and from a task you opened off the
               * overview that is the overview.
               */
              if (action.leaves === true) setNav(pop);
            }}
            tabs={tabs}
            face={task.face}
            onFace={(next) => setNav((current) => withFace(current, next))}
            /*
             * Only when the row says it can be deferred. `Later` on a shipped
             * task would be a button whose verb the extension never published.
             */
            onLater={
              byId.get(task.id)?.facts.later === undefined
                ? undefined
                : () => later(byId.get(task.id) as TriageEntry)
            }
          />
      ),
      /*
       * EDGE TO EDGE, and in FLOW — the column's content slot rather than a
       * layer over the stage. That is what makes "edge to edge" true rather than
       * merely styled: the face is measured against the space actually left, so
       * nothing inside it can sit under the chrome and nothing has to be padded
       * away from it.
       *
       * `null` on `agents`, and that absence is the feature: with no face drawn
       * the band is all this contributes, `.sh-body` keeps the room, and the
       * real panes stay on screen — still mounted, still attached to their ptys.
       */
      face:
        task.face === 'agents' || tab === undefined ? null : (
          <FaceBody
            tab={tab}
            /*
             * The extension's OWN id, not the shell's qualified one. A face asks
             * its extension about a task; `tasks.tree:task-17…` means nothing to
             * `tasks`, and handing it over would be the kind of mismatch that
             * fails silently with an empty document.
             */
            task={{ id: byId.get(task.id)?.rowId ?? task.id, root: task.root }}
            bridge={views}
          />
        ),
    };
  }

  return {
    place: 'home',
    band: null,
    face: null,
    overlays,
    home: (
      <div className="sh-take" data-testid="takeover" data-place="home">
        <TakeoverHome
          entries={entries}
          onOpen={open}
          onAnswer={answer}
          onLater={later}
          onNew={raiseComposer}
          faces={tabs}
          onOpenFace={openAt}
          /*
           * The truncation controls, and the verb that lifts one.
           *
           * Run through the same `invoke` a row's own command goes through — the
           * shell still does not know what `expandTabs` does, only that a region
           * declared this as the way to see the rest of itself.
           */
          more={more}
          onReveal={(control) =>
            invoke(control.command.id, (control.command.args ?? {}) as Readonly<Record<string, unknown>>)
          }
          /*
           * Contributed panels — `surface: 'dock'` components, which had the
           * rail and lost it. Passed rather than filtered inside, because this
           * component already has the contribution list and a second filter is
           * a second answer to "what is a panel".
           */
          panels={contributions.filter(
            (view) => view.kind === 'component' && (view.surface ?? 'dock') === 'dock',
          )}
          bridge={views}
        />
      </div>
    ),
  };
}

/**
 * The view type the `New` button raises.
 *
 * A NAME, resolved by the contribution list at the moment it is raised — the
 * shell never imports the composer and never learns what it does. It is the same
 * string the extension writes in its manifest, which is what ADR 0033 means by
 * "what crosses the port is a name": if `tasks` is not installed, `New` raises
 * nothing and the button is the only thing that was wrong.
 */
const COMPOSER_VIEW = 'tasks.composer';
