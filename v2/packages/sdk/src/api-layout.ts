import type { Disposable } from './disposable.ts';
import type { NodeID, RootID, SessionID } from './ids.ts';
import type { LayoutTarget, RegionName } from './api-sessions.ts';
import type { Result } from './result.ts';

/**
 * Layout and views (core-design §4.2).
 *
 * The tree is **read-only to extensions**. Every mutation goes through a
 * command (§4.3), which is what keeps the invariants in one normalizing funnel
 * instead of at N call sites — v1 grew three routing paths that each
 * re-implemented "and now fix up the focus", and they disagreed.
 */

export type SplitAxis = 'row' | 'column';

/**
 * `row` = ⌘D = panes SIDE BY SIDE with a vertical divider.
 * `column` = ⌘⇧D = panes STACKED.
 *
 * Read it here, never from the word: "row" means a row *of panes*, and v1
 * inverted this in three separate places before an ADR pinned it.
 */

export interface LayoutLeaf {
  readonly kind: 'leaf';
  readonly id: NodeID;
  /**
   * What this leaf shows. A leaf ALWAYS has a view; a leaf with no session is a
   * non-terminal view (a tree, a panel). The session lives on the node because
   * `layout.close` is then the one thing that ends it — if this binding lived in
   * a renderer, closing a pane over the control socket would leak the pty.
   */
  readonly view: ViewRef;
  readonly title: string;
}

export interface LayoutSplit {
  readonly kind: 'split';
  readonly id: NodeID;
  readonly axis: SplitAxis;
  /** 0..1, the first child's share. */
  readonly ratio: number;
  readonly children: readonly [LayoutNode, LayoutNode];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutRoot {
  readonly id: RootID;
  /** One tree per region. A region with no views is absent from the map. */
  readonly regions: Readonly<Partial<Record<RegionName, LayoutNode>>>;
  readonly focused: NodeID | null;
  /** Transient, never persisted — v1's rule for zoom, kept. */
  readonly zoomed: NodeID | null;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

export interface LayoutAPI {
  roots(): readonly LayoutRoot[];
  root(id: RootID): LayoutRoot | undefined;
  node(id: NodeID): LayoutNode | undefined;
  /** The leaf currently showing this session, if any. A session may have none. */
  nodeForSession(id: SessionID): NodeID | undefined;
  open(view: ViewRef, target: LayoutTarget): Promise<NodeID>;

  /**
   * **The** predicate for "is the user looking at this" (ADR 0020), computed in
   * one place from app-active + window-focused + selected root + focus + zoom
   * starvation + full-takeover overlays.
   *
   * Do not add a second visibility check anywhere. v1's hardest-won invariant is
   * that everything downstream — a state machine's landing, a banner, a chime, a
   * phone push — threads this one value rather than asking again with slightly
   * different terms.
   */
  isViewing(node: NodeID): boolean;
  onDidChangeViewing(fn: (node: NodeID, viewing: boolean) => void): Disposable;
  onDidChangeLayout(fn: (root: RootID) => void): Disposable;
}

// ------------------------------------------------------------------------ views

/** What a leaf shows. `terminal` is the one view kind core renders itself. */
export type ViewRef =
  | { readonly kind: 'terminal'; readonly sessionId: SessionID }
  | { readonly kind: 'view'; readonly type: string; readonly state?: unknown };

/**
 * A contributed view.
 *
 * M1's providers return **data**, not components. §7b decided community
 * extension UI is in-proc React, but extension *services* run in a utility
 * process — and a tree, a status item or a glyph is declarative and crosses
 * that boundary as data.
 *
 * `component` is §7b's other half (ADR 0033), and it crosses as data too: a
 * React component is functions, exactly like a `TreeDataProvider`, so what
 * travels is the **name** of a UI module and the renderer resolves it. The
 * service half of an extension never imports its own UI — that is what keeps
 * react out of the utility process, and it is why the two halves live in
 * `src/` and `ui/` with a lint boundary between them.
 */
export type ViewProvider =
  | { readonly kind: 'tree'; readonly data: TreeDataProvider; readonly title?: string }
  | {
      readonly kind: 'component';
      readonly component: string;
      /**
       * Where the shell puts it. `dock` is a section in the sidebar; `overlay`
       * is a modal card over the whole window — a composer, not a panel.
       *
       * A form the user opens, fills in and dismisses does not belong in a
       * sidebar permanently taking space; v1 learned that with its ⌘T composer,
       * and this is the same shape declared rather than hardcoded.
       */
      readonly surface?: 'dock' | 'overlay';
      /**
       * The accelerator that raises it, in Electron's vocabulary
       * (`CmdOrCtrl+T`). **A modifier is required** — a bare key here would be
       * deleted from every terminal in the app, which is v1's menu-accelerator
       * lesson. Ignored for a `dock` view, which is always on screen.
       */
      readonly key?: string;
      /** Shown as the section/card heading. Falls back to the view type. */
      readonly title?: string;
    }
  | { readonly kind: 'panel'; readonly url: string };

/**
 * What an in-proc React view is handed — the whole of it.
 *
 * Declared here rather than in the app because the component lives in the
 * extension, and an extension may import nothing but the SDK. It is a prop, not
 * a global: `main.tsx` is the one file that knows the bridge is a global, and a
 * contributed component is further from it than any core component is.
 *
 * `invoke` names a command and **cannot name a caller**. The host attributes it
 * to the extension that contributed the view — the same rule a tree row's click
 * gets (ADR 0031 D14), for the same reason: the click is the user's, the
 * command id is the extension's, and an extension's own UI must not be a way to
 * borrow the user's unconditional trust.
 */
export interface ExtensionViewProps {
  invoke(command: string, args?: unknown): Promise<Result<unknown, ViewInvokeError>>;
  /**
   * "I am finished." An overlay closes on it; a docked view ignores it.
   *
   * The component decides, not the shell: only the form knows whether a
   * successful call was the submit or a lookup it made while you were typing.
   * A shell that closed on any successful invoke would dismiss a composer the
   * moment its repo picker answered.
   */
  done(): void;
}

/**
 * The failure half of `ExtensionViewProps.invoke`.
 *
 * Deliberately narrower than `CommandError`: what reaches a page has crossed an
 * IPC boundary that carries `{code, message}` and nothing else, and a type
 * promising `commandId` or `issues` here would promise fields the wire drops.
 */
export interface ViewInvokeError {
  readonly code: string;
  readonly message: string;
}

export interface TreeItem {
  readonly id: string;
  readonly label: string;
  /**
   * A heading rather than a row — drawn as an uppercase micro-label with its
   * `description` as the count, and not clickable.
   *
   * Generic on purpose: grouping a list under headings is what every real
   * sidebar does (tasks by state, channels by workspace, PRs by repo), and the
   * alternative is each extension faking one with a row that lies about being
   * clickable.
   */
  readonly section?: boolean;
  readonly description?: string;
  /** A design-token name, resolved by the renderer. Never a raw colour. */
  readonly tint?: string;
  /**
   * Something is happening to this row's subject right now — the renderer draws
   * the app's working indicator in place of its status mark.
   *
   * Orthogonal to `tint`, which still says what the thing IS. A boolean rather
   * than a percentage on purpose: the operations behind a contributed row (a
   * git snapshot, a worktree being rebuilt) have no honest denominator, and a
   * progress bar that invents one is a bar that sticks at 90%.
   */
  readonly busy?: boolean;
  /**
   * The layout root this row stands for. The shell draws the row as SELECTED
   * while the window is on that root.
   *
   * **An identity, not a state** — which is the whole point. The row says which
   * root it is and stops; whether that root is the one on screen is the
   * layout's fact, and the shell reads it from the same snapshot it draws the
   * stage from. So the highlight and the visible pane are two readings of one
   * value and cannot disagree.
   *
   * Both of the obvious alternatives are a second copy of that fact, and both
   * shipped as bugs. A sidebar that remembered which row was CLICKED goes stale
   * the moment anything else moves the window — a command, the CLI, a closing
   * pane group falling back to home. An extension that MIRRORS the active root
   * off the bus and reports "I am selected" is the same copy one process along:
   * it has to be seeded when it starts, it lags the stage by the round trip,
   * and a dropped nudge desynchronises it.
   *
   * A root id is kernel vocabulary — the shell already routes and draws by it —
   * so naming one here tells the shell nothing about what the row MEANS. That
   * stays the extension's, in `command` and `actions`.
   *
   * Absent means "this row is not about a root", and such a row is never drawn
   * selected. A tree whose rows are files or PRs wants a selection this field
   * cannot express; add one when there is such a tree, rather than a second
   * mechanism with no consumer.
   */
  readonly root?: string;
  readonly icon?: string;
  readonly collapsed?: boolean;
  /**
   * Invoked when the row is clicked, attributed to the **contributing
   * extension** — not to the user (M3 D14).
   *
   * The click is genuinely the user's; the command id behind it is not, and they
   * cannot see it. `authorize` returns an unconditional ALLOW for
   * `{kind:'user'}`, so attributing it that way would let any extension that can
   * contribute a tree run any command with full trust — including ones its own
   * grant denies. An extension that wants a privileged verb on a row declares
   * the permission for it, like everywhere else.
   */
  readonly command?: { readonly id: string; readonly args?: unknown };
  /**
   * The row's context menu — what a right-click on it offers.
   *
   * **Declared by the extension, because the shell cannot know the verbs.** The
   * rows in the sidebar are contributed; a shell that hardcoded Reveal / Archive
   * / Delete would be a shell that knows what a task is, which is the special
   * case ADR 0031 exists to prevent. So the menu is data on the row, like
   * `command` is.
   *
   * **Attributed exactly as `command` is: to the CONTRIBUTING EXTENSION, never to
   * the user** (M3 D14). The reasoning is unchanged and applies with more force
   * here, because a menu can carry destructive verbs: the right-click is
   * genuinely the user's, but the command id behind the label is not, and they
   * cannot see it. An extension that wants a privileged verb on a menu declares
   * the permission for it, like everywhere else.
   *
   * An empty array and an absent one mean the same thing and both are legal — a
   * row with no actions has no menu, and nothing appears on right-click.
   *
   * A `{ separator: true }` entry draws a rule between two groups, which is how
   * "and these two delete things" is said without saying it in the labels.
   */
  readonly actions?: readonly (TreeItemAction | TreeItemSeparator)[];
}

/**
 * One entry in a row's context menu. It IS a command, with a label on it.
 *
 * `id` is a **command id** — the same thing `command.id` is — rather than a
 * separate action identity with a command inside it. There is nothing an action
 * can be other than a command: it cannot carry a handler (functions do not cross
 * the port) and it cannot be inert. Naming the command directly means the row's
 * click and the row's menu are one shape, and there is one attribution rule for
 * both rather than two that must agree.
 *
 * `args` rides the entry for the same reason it rides `command`: the entry names
 * WHICH task it is about, rather than the handler guessing from whatever happens
 * to be selected when the menu closes.
 */
/**
 * What a verb asks its caller to SHOW, in terms no client is privileged about.
 *
 * The problem it solves is the one that has no other honest answer: a row's
 * command runs HOST-SIDE, and `tasks.reveal` — "the whole of what clicking a row
 * means" — opens a layout root and switches to it. That is a desktop gesture. On
 * a phone it means nothing, and a phone that recovered the intent by matching
 * command ids (`if (id === 'tasks.reveal') attachPty(...)`) would have hardcoded
 * `tasks` after all, which is the exact special case ADR 0031 exists to prevent
 * — smuggled in through the client instead of the shell.
 *
 * So a verb returns what it wants PRESENTED, and each renderer decides what that
 * means for its own surface: the desktop opens a pane, a phone pushes a screen
 * and attaches. The vocabulary is deliberately tiny — a session, or a view — and
 * it earns its existence at birth rather than on promise, because it has TWO
 * renderers the day it ships.
 *
 * Additive-only, and tolerated when unknown: this crosses a wire to a client
 * that may be older than the host. A renderer that does not recognise a `kind`
 * ignores it and shows what it already had, which is a worse experience than
 * understanding it and a much better one than a refusal.
 */
export type PresentEffect =
  /** Show this session's terminal. */
  | { readonly kind: 'session'; readonly sessionId: SessionID }
  /** Show this contributed view. */
  | { readonly kind: 'view'; readonly viewType: string };

/**
 * The envelope a verb may return alongside whatever else it answers.
 *
 * Optional on purpose: most commands present nothing, and a verb that had to
 * declare an effect would invent one.
 */
export interface Presents {
  readonly present?: PresentEffect;
}

export interface TreeItemAction {
  /** A command id. Run as the contributing extension when chosen. */
  readonly id: string;
  /** What the user reads. */
  readonly label: string;
  /** A glyph NAME, resolved by the renderer against its own set. Never an SVG. */
  readonly icon?: string;
  /**
   * Destructive — drawn in the danger role.
   *
   * A boolean rather than a `variant` string, because there are two kinds of
   * menu entry and the second one is "this deletes something". A string invites
   * a third that is a colour rather than a meaning, and an extension naming a
   * colour is the thing `tint` already refuses.
   */
  readonly danger?: boolean;
  /** Displayed beside the label. The menu binds nothing — see `KeyCap`. */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly args?: unknown;
}

/** A rule between two groups of actions. */
export interface TreeItemSeparator {
  readonly separator: true;
}

export interface TreeDataProvider {
  children(parent: string | undefined): Promise<readonly TreeItem[]>;
  onDidChange?(fn: () => void): Disposable;
}

export interface StatusItem {
  readonly id: string;
  readonly text: string;
  readonly tooltip?: string;
  readonly command?: string;
}

export interface ViewAPI {
  registerViewType(type: string, provider: ViewProvider): Disposable;
  registerStatusItem(item: StatusItem): Disposable;
}
