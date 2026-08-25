import { s, type ActivateFn } from '@shepherd/sdk';
import type { TasksAPI } from '@shepherd/ext-tasks';
import { GC_MAX_AGE_MS, ScratchStore } from './store.ts';
import { SCRATCH_COMMANDS, SCRATCH_KEY, SCRATCH_VIEWS } from './manifest.ts';
import { readSkill } from './skill.ts';
import { installSkill } from './install.ts';
import { saveAs } from './save-as.ts';
import { CLAUDE_CODE, isProvider, skillsDir } from './provider.ts';
import { findTarget, skillTargets, type RepoLike } from './targets.ts';

/**
 * `layout.newTab`, named here rather than imported: values do not cross between
 * packages (`boundaries.js`), so a command id is re-stated and only types
 * travel. The same convention `github` follows for the same verb.
 */
const LAYOUT_NEW_TAB = 'layout.newTab';

/** `layout.listRoots` — the read an extension makes, for the same reason. */
const LAYOUT_LIST_ROOTS = 'layout.listRoots';

/** `layout.switchRoot` — how `scratch.reveal` goes to a tab already open. */
const LAYOUT_SWITCH_ROOT = 'layout.switchRoot';

/** `tasks`' id, re-stated: only TYPES cross between extensions (`boundaries.js`). */
const TASKS = 'shepherd.tasks';

/**
 * Which tab holds this pane.
 *
 * `layout.listRoots` rather than a field on the pane, because the pane genuinely
 * does not know: a leaf is addressed by its own id and the root is its container.
 * A miss is `undefined` and not an error — a pane can be asked about in the
 * instant after it closes.
 */
function rootHolding(roots: unknown, pane: string): string | undefined {
  if (!Array.isArray(roots)) return undefined;
  for (const entry of roots) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { root?: unknown; panes?: unknown };
    if (typeof row.root !== 'string' || !Array.isArray(row.panes)) continue;
    const holds = row.panes.some(
      (leaf) => typeof leaf === 'object' && leaf !== null && (leaf as { pane?: unknown }).pane === pane,
    );
    if (holds) return row.root;
  }
  return undefined;
}

/**
 * The root whose tree holds a pad on this buffer, if one is open.
 *
 * `unknown` all the way down: this crossed a port, and `ok` says a call
 * succeeded rather than that a value has a shape. A row that does not read is
 * skipped — an invented root would switch the user to somebody else's tab.
 */
function rootShowingScratch(roots: unknown, id: string): string | undefined {
  if (!Array.isArray(roots)) return undefined;
  for (const entry of roots) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { root?: unknown; tree?: unknown };
    if (typeof row.root !== 'string') continue;
    if (treeHoldsScratch(row.tree, id)) return row.root;
  }
  return undefined;
}

function treeHoldsScratch(node: unknown, id: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const shape = node as { kind?: unknown; pane?: unknown; first?: unknown; second?: unknown };
  if (shape.kind === 'leaf') {
    const pane = shape.pane;
    if (typeof pane !== 'object' || pane === null) return false;
    const view = (pane as { view?: unknown }).view;
    if (typeof view !== 'object' || view === null) return false;
    const held = view as { type?: unknown; state?: unknown };
    if (held.type !== SCRATCH_VIEWS.pad) return false;
    const state = held.state;
    return typeof state === 'object' && state !== null && (state as { id?: unknown }).id === id;
  }
  if (shape.kind === 'split') {
    return treeHoldsScratch(shape.first, id) || treeHoldsScratch(shape.second, id);
  }
  return false;
}

/** What the tab strip calls a scratch pane. */
const TAB_TITLE = 'scratch';

/**
 * Monotonic within a process, so two buffers minted in the same millisecond
 * cannot collide. Not a uniqueness scheme across restarts — the clock half is
 * that — and not security-bearing either way.
 */
let counter = 0;

function mintId(now: number): string {
  counter += 1;
  return `scr_${now.toString(36)}_${counter.toString(36)}`;
}

export const activate: ActivateFn = (ctx, api) => {
  const { commands, views, process, extensions } = api.proposed;
  const store = new ScratchStore(ctx.storage);

  /**
   * The repos of the task that owns a pane's tab, or none.
   *
   * Every step of it is allowed to come back empty, and none of them is a
   * failure: a scratch pane in a plain tab belongs to no task, a build with no
   * `tasks` extension resolves nothing, and a task with no repos is a real state.
   * All three land on "the user level and nothing else", which is the honest
   * answer rather than a refusal.
   */
  const reposForPane = async (pane: string): Promise<readonly RepoLike[]> => {
    const tasks = extensions.get<TasksAPI>(TASKS);
    if (tasks === undefined) return [];

    const listed = await commands.invoke(LAYOUT_LIST_ROOTS, {});
    if (!listed.ok) return [];
    const root = rootHolding(listed.value, pane);
    if (root === undefined) return [];

    const owner = tasks.list().find((task) => task.sessions.some((session) => session.root === root));
    return owner?.repos ?? [];
  };

  /*
   * Housekeeping at activation, once. A closed buffer is kept for seven days
   * (`store.ts` says why), and this is the only thing that ever removes one.
   */
  const removed = store.collect(ctx.clock.now(), GC_MAX_AGE_MS);
  if (removed > 0) ctx.log.info(`collected ${removed} closed scratch buffer(s)`);

  ctx.subscriptions.push(
    views.registerViewType(SCRATCH_VIEWS.pad, {
      kind: 'component',
      component: SCRATCH_VIEWS.pad,
      /*
       * A PANE (ADR 0044): it is a place you keep open while you work and come
       * back to after a relaunch, which is what a dock section and an overlay
       * are not.
       */
      surface: 'pane',
      title: TAB_TITLE,
      /*
       * What the tab IS, in the slot every tab keeps for a state mark.
       *
       * A scratch pane has no agent and so no state to report, and a tab strip
       * where several tabs all read `scratch` in an empty slot tells you
       * nothing. The glyph is a NAME resolved by the renderer's own allow-list
       * (ADR 0033's rule), not a component: an extension cannot reach the page
       * with an icon the build never saw.
       */
      icon: 'notes',
      key: SCRATCH_KEY,
      /*
       * The key runs a COMMAND rather than opening a pane of this type,
       * because the buffer id has to exist before `layout.newTab` can carry it
       * in `view.state` — and nothing can rewrite a pane's view state after the
       * fact.
       */
      command: SCRATCH_COMMANDS.create,
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.create, {
      title: 'Scratch: New',
      permission: 'layout',
      schema: s.nothing(),
      handler: async () => {
        const id = mintId(ctx.clock.now());
        store.create(id, ctx.clock.now());
        const created = await commands.invoke(LAYOUT_NEW_TAB, {
          view: { type: SCRATCH_VIEWS.pad, state: { id } },
          // Without this the tab reads `term`: a view pane runs no program, so
          // nothing ever sets an OSC title on it.
          title: TAB_TITLE,
        });
        return created.ok ? { id } : { ok: false, reason: created.error.message };
      },
    }),
  );

  /*
   * What notes exist, and how to get to one.
   *
   * Two verbs rather than one because they answer different questions and only
   * the second touches the layout: `editor` draws its `Notes` root from `list`
   * on every tree refresh, and calls `reveal` once, when a row is clicked.
   */
  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.list, {
      schema: s.nothing(),
      handler: () => ({ docs: store.list() }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.reveal, {
      permission: 'layout',
      schema: s.object({ id: s.string() }),
      /**
       * Go to this buffer's tab, opening one if it has none.
       *
       * The open tab is found by asking the LAYOUT what it holds rather than by
       * remembering what we opened — a record of our own would be wrong the
       * moment the user closed the tab, and wrong again across a relaunch. The
       * same shape `scratch.create` uses to open one, and the same rule
       * `github.review` established.
       */
      handler: async (args) => {
        if (store.read(args.id) === undefined) return { ok: false, reason: 'no such scratch' };

        const listed = await commands.invoke(LAYOUT_LIST_ROOTS, {});
        const on = listed.ok ? rootShowingScratch(listed.value, args.id) : undefined;
        if (on !== undefined) {
          const switched = await commands.invoke(LAYOUT_SWITCH_ROOT, { root: on });
          if (switched.ok) return { ok: true, opened: false };
        }

        const created = await commands.invoke(LAYOUT_NEW_TAB, {
          view: { type: SCRATCH_VIEWS.pad, state: { id: args.id } },
          title: TAB_TITLE,
        });
        return created.ok ? { ok: true, opened: true } : { ok: false, reason: created.error.message };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.saveAs, {
      title: 'Scratch: Save to Repo',
      schema: s.object({ id: s.string(), root: s.string(), path: s.string() }),
      /**
       * The note becomes a file.
       *
       * The KV row goes only AFTER the file exists. Dropping it first and then
       * failing the write would lose the note entirely, which is the one
       * outcome this verb must not have — and `close` rather than `delete`,
       * so even a mistake here is recoverable for seven days.
       */
      handler: (args) => {
        const doc = store.read(args.id);
        if (doc === undefined) return { ok: false, reason: 'no such scratch' };
        const wrote = saveAs(args.root, args.path, doc.text);
        if (!wrote.ok) return wrote;
        store.close(args.id, ctx.clock.now());
        return { ok: true };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.read, {
      schema: s.object({ id: s.string() }),
      handler: (args) => {
        const doc = store.read(args.id);
        if (doc === undefined) return { ok: false, reason: 'no such scratch' };
        return { text: doc.text };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.write, {
      schema: s.object({ id: s.string(), text: s.string() }),
      handler: (args) => {
        store.write(args.id, args.text, ctx.clock.now());
        return { ok: true };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.close, {
      schema: s.object({ id: s.string() }),
      handler: (args) => {
        store.close(args.id, ctx.clock.now());
        return { ok: true };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.skillTargets, {
      schema: s.object({ pane: s.string() }),
      handler: async (args) => ({ targets: skillTargets(ctx.homeDir, await reposForPane(args.pane)) }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.installSkill, {
      title: 'Scratch: Install Skill',
      /*
       * `layout`, and it is the honest grant. Writing a file needs no permission
       * (fs is stdlib), but this command is reached through a control the shell
       * draws from `layout.rename` — so it is already inside that grant, and
       * declaring a narrower one here would be a claim about the blast radius
       * that the pane's own presentation write does not honour.
       */
      permission: 'layout',
      schema: s.object({
        id: s.string(),
        /** A target id from `scratch.skillTargets`. `user`, or `repo:<path>`. */
        target: s.string(),
        /** Empty means the default — see the refusal below, which says so. */
        providers: s.optional(s.array(s.string())),
        overwrite: s.optional(s.boolean()),
      }),
      /**
       * Reads the buffer, parses it, and writes it once per provider.
       *
       * **The buffer is re-read here rather than passed in.** The pane has the
       * text on screen already, and sending it would make the installed file a
       * copy of what the renderer last thought was saved — this command's own
       * `write` is the authority, and going through the store means an install is
       * always of the document that would survive a relaunch.
       *
       * Every refusal is a `reason` rather than a throw, and each names the thing
       * the user can change.
       */
      handler: (args) => {
        const doc = store.read(args.id);
        if (doc === undefined) return { ok: false, reason: 'no such scratch' };

        const skill = readSkill(doc.text);
        if (skill === undefined) {
          return { ok: false, reason: 'this document needs a name and a description in its frontmatter' };
        }

        const chosen = args.providers === undefined || args.providers.length === 0 ? [CLAUDE_CODE] : args.providers;
        const unknown = chosen.filter((provider) => !isProvider(provider));
        if (unknown.length > 0) return { ok: false, reason: `no provider called ${unknown.join(', ')}` };

        const target = findTarget(skillTargets(ctx.homeDir, []), args.target);
        /*
         * A repo target is not in the list built from an empty repo set, so it is
         * taken from the id itself — which is what carrying the path in the id is
         * FOR. Re-resolving the task here would be a second walk that could
         * disagree with the one the picker was drawn from, and the picker's answer
         * is the one the user actually chose.
         */
        const root = target?.root ?? (args.target.startsWith('repo:') ? args.target.slice('repo:'.length) : undefined);
        if (root === undefined || root === '') return { ok: false, reason: 'no such install target' };

        const written: string[] = [];
        for (const provider of chosen) {
          const outcome = installSkill({
            skill,
            dir: skillsDir(root, provider),
            ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
          });
          /*
           * The FIRST failure stops it, and what was already written stays. With
           * one provider that is the whole story; with two, a half-install the
           * user can see beats a rollback that deletes a directory this command
           * did not create.
           */
          if (!outcome.ok) {
            return {
              ok: false,
              reason: outcome.reason,
              ...(outcome.exists === undefined ? {} : { exists: true }),
              ...(written.length === 0 ? {} : { written }),
            };
          }
          written.push(outcome.path);
        }

        ctx.log.info(`installed skill ${skill.name} to ${written.join(', ')}`);
        return { ok: true, name: skill.name, paths: written };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(SCRATCH_COMMANDS.open, {
      permission: 'process.exec',
      schema: s.object({ url: s.string() }),
      /**
       * The one thing this app will not reimplement — github's words, and the
       * same `open(1)` call with an ARGV ARRAY, so nothing in the URL is
       * interpreted by a shell.
       *
       * The guard differs from github's, and has to. Github allowlists a
       * `https://github.com/` prefix because its URLs arrive from an API
       * response; these arrive from the user's own keyboard, so the question is
       * not where the click can take you but what `open(1)` is being asked to
       * launch. A `file://` or a custom scheme is not an error here — it is a
       * link that stays text.
       */
      handler: async (args) => {
        if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
          return { ok: false, reason: 'only http and https links open' };
        }
        const opened = await process.exec(['/usr/bin/open', args.url], {
          cwd: ctx.homeDir,
          env: { HOME: ctx.homeDir, USER: ctx.userName },
          timeoutMs: 5_000,
        });
        return opened.ok ? { ok: true } : { ok: false, reason: opened.stderr.trim() || 'could not open a browser' };
      },
    }),
  );
};
