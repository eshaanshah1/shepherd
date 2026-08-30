/**
 * What a banner says, and what its buttons do.
 *
 * The shape exists because the alternative was two strings: a title composed
 * from a raw state word (`Turn finished`) and a body that was the alert reason
 * or, failing that, the state word again. Run four agents and the four banners
 * were indistinguishable — none named its task, none said what changed, and
 * clicking one raised the app to wherever it happened to be.
 *
 * **The shell never learns what any of this means.** A `command` is run as
 * handed and a `goto` names a task and, optionally, a face; the composing
 * extension owns both vocabularies. That is the same refusal `menuDispatcher`
 * makes for a menu item, pointed at the one surface that reaches the user when
 * Shepherd does not have the screen.
 */

export interface AlertGoto {
  readonly task: string;
  /**
   * A face slot (`agents`, `diff`, …) — the way of reading the task this alert
   * is about. Absent means "the shell decides", which is the honest answer for
   * an alert with no opinion: the page already has one (`openingFace`).
   */
  readonly face?: string;
}

/**
 * A button on a banner: a VERB the shell runs, or a PLACE it goes.
 *
 * `{command, args}` is deliberately the shape a row's answers and its `later`
 * options already cross the port with. One vocabulary for "a thing the user can
 * press that belongs to somebody else" means a verb offered on a row can be
 * offered on a banner without either end learning anything new.
 */
export type AlertAction =
  | { readonly label: string; readonly command: string; readonly args?: unknown }
  | { readonly label: string; readonly goto: AlertGoto };

export interface AlertSpec {
  /** The task's name. Never the state word — that is what `subtitle` is for. */
  readonly title: string;
  readonly subtitle?: string;
  /** The line that says something the state cannot: why, or what changed. */
  readonly body: string;
  /**
   * At most two, and that is a platform fact rather than taste: macOS renders
   * the first as a button and folds the rest into a dropdown, and a dropdown in
   * a banner is a menu nobody opens.
   */
  readonly actions?: readonly AlertAction[];
  /** Where the BODY goes when clicked. Absent means "just raise the app". */
  readonly click?: AlertGoto;
}
