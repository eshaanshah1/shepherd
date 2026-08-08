/**
 * The id of the layout root a task owns — derived, in ONE place.
 *
 * A task is a pane group: its agents live in a root of their own, so switching
 * to a task is a `layout.switchRoot` and finishing with one is a
 * `layout.closeRoot`. That means the same string is built by `startSession`, by
 * `tasks.reveal`, by `tasks.delete` and by `tasks.archive` — and four callers
 * each writing `` `task:${id}` `` is four chances for one of them to disagree,
 * at which point a task closes a root nobody is looking at and leaves its own
 * panes running.
 *
 * It is deliberately **not** branded as a `RootID`: core brands it at the edge
 * (`rootId(args.root)`), and an extension names roots the same way it names
 * panes — as opaque strings that crossed a port.
 *
 * The prefix is a namespace, not decoration: `window-1` is the shell's home
 * root and every other root belongs to somebody. `task:` says whose.
 */
export function taskRootId(taskId: string): string {
  return `task:${taskId}`;
}
