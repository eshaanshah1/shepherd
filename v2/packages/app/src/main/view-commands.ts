import type { CommandRegistry } from '@shepherd/core';
import { s, type Disposable, type TreeItem } from '@shepherd/sdk';
import { refuseExternalCaller } from './in-process-only.ts';
import type { Contribution } from './view-registry.ts';

/**
 * Contributed views, as COMMANDS — all five of them, since Stage 2 of the
 * core/UI isolation.
 *
 * `views.list` and `views.children` have been verbs since M3, with the renderer
 * reaching them through IPC channels that were called "a projection, not a
 * rival". They were a rival: same questions, second implementation, and the
 * renderer's version answered a richer shape than the socket's, so the two
 * disagreed about what a contributed view even is. Now there is one answer, and
 * a TUI drawing the sidebar gets the same declarative record the dock does.
 *
 * The other three — `activate`, `invoke`, `present` — were renderer-only, which
 * is to say a private door the app had and nothing else did. They are verbs now.
 * Their D14 attribution (a row's command runs as the extension that contributed
 * it) makes them a way to *become* an extension, so they carry
 * `refuseExternalCaller` until the kernel can check a command against what the
 * view actually offered; see that file for the whole argument.
 *
 * The options are functions rather than a `ViewRegistry` because this Mac's
 * views and another member's are answered by different objects and the caller
 * must not be able to tell (`remote-views.ts`). One table, one dispatch on the
 * one fact that distinguishes them: which member owns the type.
 */

export const VIEW_COMMANDS = {
  list: 'views.list',
  children: 'views.children',
  activate: 'views.activate',
  invoke: 'views.invoke',
  present: 'views.present',
} as const;

/** What a client is told about a contributed view. Declarations, never code. */
export type ViewSummary = Contribution & {
  /** Whose view this is, when it is not this Mac's. */
  readonly remote?: { readonly memberId: string; readonly name: string };
};

/** The answer `views.present` gives: what happened, so a click can report itself. */
export interface PresentOutcome {
  readonly shown: boolean;
  readonly reason?: string;
}

export interface ViewCommandsOptions {
  readonly registry: CommandRegistry;
  /** Every contribution a client may draw — this Mac's and every member's. */
  list(): readonly ViewSummary[];
  children(type: string, parent: string | undefined): Promise<readonly TreeItem[]>;
  /** A row was clicked. Attributed to the extension that contributed the view. */
  activate(type: string, command: string, args: unknown): Promise<void>;
  /** The same gesture with the answer kept, for a contributed component. */
  invoke(type: string, command: string, args: unknown): Promise<unknown>;
  /** Show what a row of ANOTHER member's view stands for, here. */
  present(type: string, command: string, args: unknown): Promise<PresentOutcome>;
}

export function registerViewCommands(options: ViewCommandsOptions): Disposable {
  const { registry } = options;

  const subscriptions: Disposable[] = [
    registry.register(VIEW_COMMANDS.list, {
      title: 'Views: List',
      permission: 'views',
      schema: s.nothing(),
      /**
       * Still wrapped in `{ views }` rather than answered as a bare array: this
       * is what a paired member's client reads off another Mac
       * (`remote-views.ts`), and the envelope is the only place a later field —
       * a capability, a version — could go without breaking every reader.
       */
      handler: (): { views: readonly ViewSummary[] } => ({ views: options.list() }),
    }),

    registry.register(VIEW_COMMANDS.children, {
      title: 'Views: Children',
      permission: 'views',
      schema: s.object({ type: s.string(), parent: s.optional(s.string()) }),
      /**
       * A tree's rows.
       *
       * Answers `[]` for an unknown view or a `component` one rather than
       * failing: a client asking for rows of something that has none is out of
       * date, not broken, and an error would make every version skew look like a
       * fault.
       */
      handler: async (args: { type: string; parent?: string }): Promise<readonly TreeItem[]> =>
        options.children(args.type, args.parent),
    }),

    registry.register(VIEW_COMMANDS.activate, {
      // No title: it names a view type and a command id, so there is nothing for
      // a person to pick out of a palette.
      permission: 'views',
      schema: s.object({ type: s.string(), command: s.string(), args: s.optional(s.unknown()) }),
      handler: async (args, caller) => {
        refuseExternalCaller(caller, VIEW_COMMANDS.activate);
        await options.activate(args.type, args.command, args.args);
        return { activated: true };
      },
    }),

    registry.register(VIEW_COMMANDS.invoke, {
      permission: 'views',
      schema: s.object({ type: s.string(), command: s.string(), args: s.optional(s.unknown()) }),
      /**
       * `activate` with the answer kept — what a contributed component needs
       * (ADR 0033), because a form has to show what happened.
       *
       * A failure comes back as a thrown `handler-failed` carrying the inner
       * message, so a refused create reaches the form as a sentence it can draw
       * ("that path is not a git repo") rather than as a silent no-op.
       */
      handler: async (args, caller) => {
        refuseExternalCaller(caller, VIEW_COMMANDS.invoke);
        return options.invoke(args.type, args.command, args.args);
      },
    }),

    registry.register(VIEW_COMMANDS.present, {
      permission: 'views',
      schema: s.object({ type: s.string(), command: s.string(), args: s.optional(s.unknown()) }),
      /**
       * Deliberately NOT `activate` for a remote row: that runs the row's own
       * gesture, which for a task opens a pane and switches the window on the
       * OTHER Mac while leaving this one showing nothing.
       */
      handler: async (args, caller): Promise<PresentOutcome> => {
        refuseExternalCaller(caller, VIEW_COMMANDS.present);
        return options.present(args.type, args.command, args.args);
      },
    }),
  ];

  return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
}
