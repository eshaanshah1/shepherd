/**
 * The root the window opens on, and the group the loose shells live in.
 *
 * `layout.open()` defaults to this id (`core/layout/store.ts`), main names it
 * when it opens the first root, and the `shell` extension names it as
 * `SHELL_GROUP` because ADR 0047 put the loose terminals in the HOME root's
 * group rather than in a store of their own.
 *
 * Three copies of a literal is how the three drift, so main and the renderer
 * share this one. The extension keeps its own — it cannot import the app, which
 * is the boundary working rather than failing — and its `manifest.test.ts`
 * pins the same string from the other side.
 *
 * The renderer needs it to answer one question the layout alone can answer: is
 * this contributed row a TASK or a PLACE? A row standing for a root in this
 * group is a loose terminal — no lifecycle, never in the queue — and the
 * takeover files it under `Shells` whatever state it happens to be tinted.
 */
export const HOME_ROOT_ID = 'window-1';
