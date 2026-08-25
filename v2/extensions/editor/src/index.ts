import { s, type ActivateFn } from '@shepherd/sdk';
import { EDITOR_COMMANDS, EDITOR_VIEWS, TAB_TITLE } from './manifest.ts';
import { filePatch, listPaths, listStatus } from './git.ts';
import { readFileAt, writeFileAt } from './files.ts';
import { activeCwd, activeGroup, openEditorRoot, readRoots } from './roots.ts';
import { readTasks, taskInGroup } from './tasks-read.ts';
import { notePath, readNotes } from './notes.ts';

/**
 * The layout verbs, named here rather than imported: values do not cross
 * between packages (`boundaries.js`), so a command id is re-stated and only
 * types travel. The same convention `scratch` and `github` follow.
 */
const LAYOUT_LIST_ROOTS = 'layout.listRoots';
const LAYOUT_SWITCH_ROOT = 'layout.switchRoot';
const LAYOUT_NEW_TAB = 'layout.newTab';

/**
 * `scratch.list` — the notes that have not chosen a path yet.
 *
 * Another extension's command id, written out for the same reason the layout
 * ones are. The manifest's `dependencies` entry is what makes the call legal;
 * a value import would route around that gate.
 */
const SCRATCH_LIST = 'scratch.list';

/** `tasks.list` — where a task's work is, which is what the editor opens on. */
const TASKS_LIST = 'tasks.list';

/** The stamp `editor.read` handed out, coming back on the write it guards. */
const STAMP = s.object({ mtimeMs: s.number(), size: s.number() });

export const activate: ActivateFn = (ctx, api) => {
  const { commands, views, process } = api.proposed;

  ctx.subscriptions.push(
    views.registerViewType(EDITOR_VIEWS.workspace, {
      kind: 'component',
      component: EDITOR_VIEWS.workspace,
      /*
       * A PANE (ADR 0044): it has a subject, you keep it open while you work,
       * and you come back to it after a relaunch — which is what a dock section
       * and an overlay are not. That ADR named a diff view as one of the shapes
       * that would follow `github`; this is it.
       */
      surface: 'pane',
      title: TAB_TITLE,
      /*
       * The tab's glyph, in the slot a terminal tab draws its agent state in. A
       * view pane has no agent and so no state to report, and a strip where
       * several tabs all read `editor` in an empty slot says nothing. A NAME
       * resolved by the renderer's own allow-list (ADR 0033), never a
       * component: an extension cannot reach the page with a glyph the build
       * never saw, and `declared-glyphs.test.ts` in the app asserts exactly
       * that — it caught `file`, which is not one.
       *
       * `folder`, because the pane's SUBJECT is a directory: `state.root` is a
       * path, the tree spans everything under it, and the file you happen to be
       * editing is a position within it rather than what the tab is.
       */
      icon: 'folder',
    }),
  );

  // ------------------------------------------------------------------ the tree

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.tree, {
      schema: s.object({ root: s.string() }),
      /**
       * The paths and their marks together, in one answer.
       *
       * Two commands would land the marks a frame after the rows they belong
       * to, and the tree would flicker from clean to modified on every refresh.
       * They are also the same question asked of the same directory, so the two
       * git calls overlap rather than queue.
       */
      handler: async (args) => {
        const [walked, status, notes] = await Promise.all([
          listPaths(process, args.root),
          listStatus(process, args.root),
          /*
           * The `Notes` root: a scratchpad is a document that has not chosen a
           * path yet, so the one tree that lists what you can edit lists those
           * too. A build with no `scratch` extension answers not-ok, which is a
           * real state — no Notes root, and the rest of the tree is unaffected.
           */
          commands
            .invoke(SCRATCH_LIST, {})
            .then((answer) => (answer.ok ? readNotes(answer.value) : [])),
        ]);
        return {
          paths: [...notes.map(notePath), ...walked.paths],
          truncated: walked.truncated,
          status,
          notes,
        };
      },
    }),
  );

  // ----------------------------------------------------------------- the files

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.read, {
      schema: s.object({ root: s.string(), path: s.string() }),
      handler: (args) => {
        const read = readFileAt(args.root, args.path);
        if ('error' in read) return { ok: false, reason: read.error };
        return { text: read.text, stamp: read.stamp };
      },
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.write, {
      schema: s.object({
        root: s.string(),
        path: s.string(),
        text: s.string(),
        stamp: STAMP,
      }),
      /**
       * A refusal is a `reason`, not a throw.
       *
       * `stale` is the expected outcome here rather than an exceptional one —
       * an agent is editing this worktree while the user is — and the pane has
       * something specific to do about it (offer a reload). An error would
       * flatten that into "could not save".
       */
      handler: (args) => {
        const wrote = writeFileAt(args.root, args.path, args.text, args.stamp);
        if ('error' in wrote) return { ok: false, reason: wrote.error };
        return { stamp: wrote.stamp };
      },
    }),
  );

  // --------------------------------------------------------------- the changes

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.changes, {
      schema: s.object({ root: s.string() }),
      handler: async (args) => ({ entries: await listStatus(process, args.root) }),
    }),
  );

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.diff, {
      schema: s.object({ root: s.string(), path: s.string(), untracked: s.boolean() }),
      handler: async (args) => ({
        patch: await filePatch(process, args.root, args.path, args.untracked),
      }),
    }),
  );

  // ------------------------------------------------------------------ the verb

  ctx.subscriptions.push(
    commands.register(EDITOR_COMMANDS.open, {
      title: 'Editor: Open',
      schema: s.object({ path: s.optional(s.string()) }),
      /**
       * Open the editor on a directory, or go to the tab already on it.
       *
       * With no `path` it opens on **the task you are in** — its ROOT, the
       * directory its repos have worktrees under.
       *
       * NOT the focused pane's cwd, which was the first answer and the wrong
       * one: a shell that has `cd`'d into a package opens the editor on that
       * package, so the tree is rooted three levels inside the work and the
       * rest of the task is unreachable from it. The cwd remains the fallback
       * for a tab that belongs to no task (a loose shell), where it is the only
       * thing that says where you are.
       *
       * That is the whole reason `layout.listRoots` reports `active`: a verb run
       * from ⌘K has no pane to derive it from, and the alternative was making
       * the palette entry useless without an argument.
       *
       * The existing tab is found by asking the LAYOUT what it holds rather
       * than by remembering what we opened: a record of our own would be wrong
       * the moment the user closed the tab, and wrong again across a relaunch.
       * `github.review` established this and there is no reason for a second
       * answer.
       */
      handler: async (args) => {
        const listed = await commands.invoke(LAYOUT_LIST_ROOTS, {});
        const roots = listed.ok ? readRoots(listed.value) : [];

        const listedTasks = await commands.invoke(TASKS_LIST, {});
        const task = taskInGroup(
          listedTasks.ok ? readTasks(listedTasks.value) : [],
          activeGroup(roots),
        );

        const root = args.path ?? task?.root ?? activeCwd(roots);
        if (root === undefined) {
          return { ok: false, reason: 'nothing here says which directory to open — pass a path' };
        }

        const already = openEditorRoot(roots, root);
        if (already !== undefined) {
          const switched = await commands.invoke(LAYOUT_SWITCH_ROOT, { root: already });
          if (switched.ok) return { ok: true, root, opened: false };
        }

        const created = await commands.invoke(LAYOUT_NEW_TAB, {
          view: { type: EDITOR_VIEWS.workspace, state: { root } },
          // Without this the tab reads `term`: a view pane runs no program, so
          // nothing ever sets an OSC title on it.
          title: TAB_TITLE,
        });
        return created.ok
          ? { ok: true, root, opened: true }
          : { ok: false, reason: created.error.message };
      },
    }),
  );
};
