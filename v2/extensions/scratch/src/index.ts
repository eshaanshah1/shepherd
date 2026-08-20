import { s, type ActivateFn } from '@shepherd/sdk';
import { GC_MAX_AGE_MS, ScratchStore } from './store.ts';
import { SCRATCH_COMMANDS, SCRATCH_KEY, SCRATCH_VIEWS } from './manifest.ts';

/**
 * `layout.newTab`, named here rather than imported: values do not cross between
 * packages (`boundaries.js`), so a command id is re-stated and only types
 * travel. The same convention `github` follows for the same verb.
 */
const LAYOUT_NEW_TAB = 'layout.newTab';

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
  const { commands, views, process } = api.proposed;
  const store = new ScratchStore(ctx.storage);

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
