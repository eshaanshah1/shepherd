import { statSync } from 'node:fs';
import { s, toDisposable, type ActivateFn, type TreeItem } from '@shepherd/sdk';
import type { AgentState } from '@shepherd/ext-agents-core/state';
import { SHELL_COMMANDS, SHELL_GROUP, SHELL_VIEWS } from './manifest.ts';
import { repoAt } from './model/repo.ts';
import { capRows, type ShellRow } from './model/rows.ts';
import { tintFor } from './model/state.ts';

/**
 * Kernel command ids, named here rather than imported: values do not cross
 * between packages (`boundaries.js`), so an id is re-stated and only types
 * travel. The convention `scratch` and `github` both follow for the same verbs.
 */
const LAYOUT_LIST_ROOTS = 'layout.listRoots';
const LAYOUT_SWITCH_ROOT = 'layout.switchRoot';
const LAYOUT_OPEN_ROOT = 'layout.openRoot';
/**
 * `tasks.create` declares no `permission`, so invoking it needs no grant beyond
 * being a loaded extension — D9b's rule is that membership in `grants` is
 * required even for a command with no permission, and a loaded extension has it.
 */
const TASKS_CREATE = 'tasks.create';

/** The layout saying its set of roots moved. */
const ROOTS_CHANGED_TOPIC = 'layout.rootsChanged';
/** `agents-core` saying a session's state moved. */
const AGENT_STATE_TOPIC = 'agents.stateChanged';

interface AgentStateChanged {
  readonly session?: unknown;
  readonly to?: unknown;
}

/**
 * One root of the home group, as much of it as the rail needs.
 *
 * "Shell" is this extension's internal name and the region's is `Scratchpad`,
 * deliberately: what it lists is every tab of the home root, and a markdown
 * scratch pane opened with ⌘⇧N is one of those. Filtering to roots running a
 * session would make a loose scratch pane unreachable again, which is the same
 * lostness this region exists to end, one pane type along.
 */
interface MirroredRoot {
  readonly root: string;
  readonly label: string;
  /** The focused pane's glyph, by name, or `null` for a terminal. */
  readonly icon: string | null;
  readonly session: string | null;
  readonly cwd: string | null;
  readonly hasPanes: boolean;
}

export const activate: ActivateFn = (ctx, api) => {
  const { commands, events, views } = api.proposed;

  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const fn of listeners) fn();
  };

  /**
   * The home group's roots, mirrored — the layout, as much of it as the rail
   * needs.
   *
   * A MIRROR because reads do not cross the port (`LayoutAPI`'s getters throw
   * `ACROSS_A_PORT`), so an extension subscribes to an announcement and re-reads
   * through a command. `layout.listRoots` is the single authority: nothing here
   * derives a label and nothing invents an id.
   *
   * It is emphatically NOT a copy of which root is on SCREEN. That question is
   * the layout's alone, answered by the shell from the snapshot it draws the
   * stage from (ADR 0035); what this holds is which shells EXIST and what they
   * are called, which nothing else can tell this extension.
   */
  let mirrored: readonly MirroredRoot[] = [];

  /** `session → state`, for the one column `listRoots` cannot answer. */
  const agentState = new Map<string, AgentState>();

  /**
   * Whether the overflow is open.
   *
   * In memory and never stored: it is a property of this window's rail rather
   * than of the shells, and a persisted one would restore a rail expanded from a
   * session nobody remembers.
   */
  let expanded = false;

  const refresh = async (): Promise<void> => {
    const answer = await commands.invoke<readonly unknown[]>(LAYOUT_LIST_ROOTS, { group: SHELL_GROUP });
    /*
     * Read defensively at every step. This crossed a port, and `ok` says the
     * call succeeded rather than that the value has a shape — a cast is not a
     * check, and a provider answering something that is not an array is exactly
     * what took the composer's whole form down with a `TypeError`.
     */
    if (!answer.ok || !Array.isArray(answer.value)) {
      mirrored = [];
      changed();
      return;
    }
    const next: MirroredRoot[] = [];
    for (const raw of answer.value) {
      const row = raw as {
        root?: unknown;
        label?: unknown;
        icon?: unknown;
        focusedSession?: unknown;
        panes?: unknown;
      };
      if (typeof row.root !== 'string') continue;
      const panes = Array.isArray(row.panes) ? row.panes : [];
      const focused = panes[0] as { cwd?: unknown } | undefined;
      next.push({
        root: row.root,
        /*
         * Straight from `listRoots`, which is the single authority: `displayTitle`
         * resolves the user's title, else the program's, else core's own default,
         * and it never answers blank — a root with no FOCUSED pane does, and
         * `hasPanes` above has already dropped those.
         *
         * So the fallback guards a malformed answer across the port and nothing
         * else. An earlier version made it `~` on the theory that a blank label
         * meant `$HOME`; it does not, and that branch was unreachable.
         *
         * Never the root id — `window-1/tab-2` in the sidebar is an internal name.
         */
        label: typeof row.label === 'string' && row.label !== '' ? row.label : 'term',
        /*
         * The focused pane's own glyph, straight from `listRoots` beside its
         * label — the same single authority, for the same reason.
         *
         * This extension does not know what a scratch pane is and must not: it
         * carries a NAME across and the shell resolves it against the renderer's
         * allow-list (ADR 0033). A pane that publishes none answers `null`, which
         * is every terminal — and a terminal's leading slot is its state.
         */
        icon: typeof row.icon === 'string' && row.icon !== '' ? row.icon : null,
        session: typeof row.focusedSession === 'string' ? row.focusedSession : null,
        cwd: typeof focused?.cwd === 'string' ? focused.cwd : null,
        hasPanes: panes.length > 0,
      });
    }
    mirrored = next;
    changed();
  };

  /**
   * Whether a path holds a `.git` — a DIRECTORY in a normal clone and a FILE in a
   * linked worktree, so this asks whether the entry exists at all rather than
   * what kind it is (`tasks`' `suggest.ts` records the same).
   *
   * The only filesystem this extension touches, and it is `node:fs` rather than
   * `git rev-parse --show-toplevel` deliberately: `process.exec` is the heaviest
   * grant in the system and this question is answerable by looking.
   */
  const isRepo = (path: string): boolean => {
    try {
      return statSync(`${path}/.git`, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  };

  const repoOf = (root: string): { path: string; name: string } | null => {
    const found = mirrored.find((one) => one.root === root);
    return found?.cwd === null || found?.cwd === undefined ? null : repoAt(found.cwd, isRepo);
  };

  const stateOf = (root: MirroredRoot): AgentState | undefined =>
    root.session === null ? undefined : agentState.get(root.session);

  /**
   * A shell is a root with a PANE in it.
   *
   * The home root itself is in this group and is minted empty at launch, so it
   * arrives with no panes and no label — and it is the one root `closeRoot`
   * refuses, so closing its last pane empties it rather than closing it. Listed,
   * it drew a permanent row reading `Empty` that stood for nothing, could not be
   * closed, and was the first thing under the heading.
   *
   * Filtering it out also retires a wrinkle this design had accepted: there is no
   * undeletable first row any more, because the root that cannot be closed is not
   * a row at all.
   */
  const shellRows = (): readonly ShellRow[] =>
    mirrored
      .filter((root) => root.hasPanes)
      .map((root) => {
        const state = stateOf(root);
        return {
          root: root.root,
          label: root.label,
          ...(root.icon === null ? {} : { icon: root.icon }),
          ...(state === undefined ? {} : { state }),
        };
      });

  /**
   * Just the shells, capped. **No head row.**
   *
   * The region is named by the view's own `title`, which the dock draws as a
   * `SectionLabel` — so an extension inventing a first row to name its own list
   * would be a second answer to a question the contribution already answers, and
   * a row is the wrong shape for it: at the row's own size and weight it read as a
   * fourth sibling rather than as the thing the others belong to.
   *
   * What that gives up, written down rather than discovered later: the region has
   * no click of its own (⌘0 is the navigation) and cannot be lit as a whole, so
   * while the active shell is behind the overflow row nothing in the rail is
   * highlighted.
   */
  const rows = (): readonly TreeItem[] =>
    capRows(shellRows(), expanded).map((row): TreeItem => {
      if ('kind' in row) {
        return {
          id: `shell:${row.kind}`,
          label: row.kind === 'more' ? `… +${row.count}` : '… less',
          /*
           * Clickable, deliberately: a row reading "… +2" that did nothing when
           * pressed is what `section` exists to avoid.
           */
          command: { id: SHELL_COMMANDS.expand },
          /*
           * A CONTROL on the list rather than an entry in it. Without this it is
           * body type at full ink under rows drawn a step down, and the loudest
           * pixel in the rail is the thing you care least about.
           */
          quiet: true,
        };
      }
      const tinted = row.state === undefined ? undefined : tintFor(row.state);
      /*
       * Offered only when there IS a repo above the cwd. A menu entry that
       * created a task rooted nowhere would fail one process away, naming a path
       * nobody typed — and the first shell anyone opens is in `$HOME`, which is
       * not a repo.
       */
      const repo = repoOf(row.root);
      return {
        id: `shell:${row.root}`,
        label: row.label,
        root: row.root,
        ...(tinted === undefined ? {} : { tint: tinted }),
        /*
         * Sent whether or not there is a tint, and the SHELL decides which wins —
         * the same division the tab strip makes, where a glyph shares the mark's
         * slot and loses to it. Deciding here would mean this extension knew how
         * wide the slot is and what else competes for it.
         *
         * `undefined`, not `null`: `ShellRow` carries the field ABSENT for a
         * terminal, and a `=== null` guard here spread `{ icon: undefined }` — a
         * key present on the wire with no value, which is a different answer from
         * "this row has no glyph" to anything that asks whether the key is there.
         */
        ...(row.icon === undefined ? {} : { icon: row.icon }),
        command: { id: LAYOUT_SWITCH_ROOT, args: { root: row.root } },
        ...(repo === null
          ? {}
          : {
              actions: [
                { id: SHELL_COMMANDS.promote, label: `Start a task in ${repo.name}`, args: { root: row.root } },
              ],
            }),
      };
    });

  ctx.subscriptions.push(
    views.registerViewType(SHELL_VIEWS.tree, {
      kind: 'tree',
      title: 'Scratchpad',
      /*
       * Above the task list, declared rather than lucked into.
       *
       * The claim is the VIEW's because the dock renders one section per view and
       * merges rows only within a section — a row saying "I am first" reorders its
       * own siblings and nothing else. Without this the section sat above the
       * tasks only because this extension happens to activate before `tasks`.
       */
      head: true,
      data: {
        children: () => Promise.resolve(rows()),
        onDidChange: (fn) => {
          listeners.add(fn);
          return toDisposable(() => listeners.delete(fn));
        },
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SHELL_COMMANDS.expand, {
      permission: 'views',
      schema: s.nothing(),
      handler: () => {
        expanded = !expanded;
        changed();
        return { expanded };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SHELL_COMMANDS.reveal, {
      title: 'Shell: Reveal',
      permission: 'layout',
      /*
       * `s.nothing()` accepts an absent value AND an empty object, which is what
       * makes it safe here: the menu sends `args: {}`. Do not "tidy" it to
       * `s.object({})`, which rejects an absent one — the two used to disagree and
       * no generic client could speak to both.
       */
      schema: s.nothing(),
      /**
       * Go to the shells — navigation, not creation, and idempotent.
       *
       * A key that opened a shell on every press would silt up tabs and is the
       * wrong reading of ⌘0, which means HOME. It opens one only when there is
       * nothing to go to.
       *
       * The FIRST root with panes, in creation order, rather than the last
       * focused: per-group last-focused is not tracked, teaching the kernel about
       * it is a larger change than this earns, and a fixed landing spot is
       * predictable. The tab strip is there for the rest.
       */
      handler: async () => {
        await refresh();
        const live = mirrored.find((root) => root.hasPanes);
        if (live !== undefined) {
          await commands.invoke(LAYOUT_SWITCH_ROOT, { root: live.root });
          return { root: live.root };
        }
        /*
         * No `cwd`, deliberately. `defaultSessionSpec` omits it when a pane has
         * none and main fills it from `shellDefaults()`, whose cwd is
         * `systemHome()` — so a fresh shell opens in $HOME without this extension
         * reaching `node:os`, which it may not do. It is also why a blank label
         * has to read as `~`.
         */
        await commands.invoke(LAYOUT_OPEN_ROOT, { root: SHELL_GROUP });
        await commands.invoke(LAYOUT_SWITCH_ROOT, { root: SHELL_GROUP });
        await refresh();
        return { root: SHELL_GROUP };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SHELL_COMMANDS.promote, {
      permission: 'layout',
      schema: s.object({ root: s.string() }),
      /**
       * Start a task on the repo this shell is sitting in.
       *
       * **It does not move the pane**, and that is the whole of the claim. A root
       * is fixed to its group at mint, and a task's agent runs in a fresh worktree
       * anyway — so the shell's cwd would be the wrong directory once the task
       * exists. What this saves is typing a path into the composer.
       */
      handler: async (args) => {
        await refresh();
        const repo = repoOf(args.root);
        if (repo === null) {
          throw new Error(`no git repo at or above the shell at ${args.root}`);
        }
        const created = await commands.invoke(TASKS_CREATE, { repos: [repo] });
        if (!created.ok) throw new Error(`could not create a task in ${repo.name}: ${created.error.message}`);
        return created.value;
      },
    }),
  );

  ctx.subscriptions.push(events.on(ROOTS_CHANGED_TOPIC, () => void refresh()));

  /*
   * Subscribing WITHOUT declaring a permission, deliberately. `events.on` is
   * membership-gated only — being a loaded extension is the whole of the check —
   * while `attention.set`/`clear` are what the `attention` permission guards. So
   * this is a READ of a fact `agents-core` announces, and ADR 0026's
   * single-writer rule is untouched: nothing below writes state, it only mirrors
   * what was announced.
   */
  ctx.subscriptions.push(
    events.on<AgentStateChanged>(AGENT_STATE_TOPIC, (payload) => {
      /*
       * Structural, not schematic: the payload crossed a port, and a malformed
       * one must be dropped rather than keying the mirror on `undefined` — which
       * could then never be cleared, since no later change can name that key.
       */
      if (typeof payload?.session !== 'string' || typeof payload.to !== 'string') return;
      agentState.set(payload.session, payload.to as AgentState);
      changed();
    }),
  );

  void refresh();
};
