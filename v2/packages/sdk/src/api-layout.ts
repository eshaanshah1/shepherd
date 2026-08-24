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
  /**
   * The pane group this root is a TAB OF — an opaque string, defaulting to the
   * root's own id, so a root nobody grouped is a group of one.
   *
   * An extension filters by it to find the tabs of something it owns (`tasks`
   * names its group `task:<id>`). Nothing in core reads it: what a group MEANS
   * is the business of whoever opened the roots, which is the same rule that
   * keeps the kernel from knowing what a task is (ADR 0031).
   */
  readonly group: string;
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
  | ({ readonly kind: 'view' } & PaneView);

/**
 * A contributed view, as a PANE holds it — a registered view `type` plus
 * whatever that view needs to know which subject it is showing.
 *
 * Its own type because a pane persists one (`serialize.ts`) and a command
 * accepts one, so the shape is written down in three places that must agree. It
 * is deliberately not a component name: the type resolves through the
 * contribution list like every other view, so a pane restored before its
 * extension activates draws the empty slot and fills in when the registration
 * arrives — where a component name would let a pane reach the renderer's table
 * with nothing declared behind it.
 *
 * `state` is the subject and nothing else — an id, a path, a pair of them. It
 * crosses the port as JSON and comes back `unknown`, so a view reads it
 * defensively; and it is the one field a pane may carry that the kernel does not
 * understand, which is the same bargain `TreeItem.data` already makes.
 */
export interface PaneView {
  readonly type: string;
  readonly state?: unknown;
}

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
  | {
      readonly kind: 'tree';
      readonly data: TreeDataProvider;
      readonly title?: string;
      /**
       * A search field above the rows, which the extension answers.
       *
       * `TreeDataProvider` is `children(parent)` and nothing else, so a query has
       * nowhere to live unless somebody owns it — and it has to be the extension.
       * Only the extension knows the rows it did NOT send (`tasks` caps the
       * shipped list, and search is how you reach past the cap), and only the
       * extension sets `collapsed` (a match is drawn expanded so you can jump
       * straight to the right tab). A shell-side filter over the rows it happens
       * to hold could do neither.
       *
       * So the shell draws the field, sends each change to `command` as
       * `{ query }`, and redraws when the provider fires `onDidChange` — the same
       * mechanism a row's click already uses to toggle extension state.
       */
      readonly search?: { readonly command: string; readonly placeholder?: string };
      /**
       * This section sits ABOVE every section that does not claim it.
       *
       * A view-level claim rather than a row-level one, and that distinction is
       * the whole of it: the dock renders **one section per view** and merges
       * rows only WITHIN a section, so a row saying "I am first" can only ever
       * reorder its own siblings. Where a section goes is a fact about the
       * section.
       *
       * It exists because that position was otherwise undeclarable. Section
       * order is the order `views.list()` answers in, which is registration
       * order, which is activation order — so a section sat above another by
       * luck, and the luck changed whenever anything touched the activation
       * list.
       *
       * Deliberately a boolean and deliberately only on a TREE. A number invites
       * a second view picking a bigger one, which is the arithmetic race
       * `REGIONS` is named as the scope-creep door for; and a tree is always a
       * dock section, while a component may be an overlay or a pane. Widening it
       * to a dock component is one line, when something wants it.
       *
       * Ties keep registration order, so two sections both claiming it stay in
       * whatever order they were declared rather than swapping under you.
       */
      readonly head?: boolean;
    }
  | {
      readonly kind: 'component';
      readonly component: string;
      /**
       * Where the shell puts it. `dock` is a section in the sidebar; `overlay`
       * is a modal card over the whole window — a composer, not a panel;
       * `pane` is a leaf of the layout tree, beside the terminals.
       *
       * A form the user opens, fills in and dismisses does not belong in a
       * sidebar permanently taking space; v1 learned that with its ⌘T composer,
       * and this is the same shape declared rather than hardcoded.
       *
       * `pane` is the third and it is a different KIND of thing from the other
       * two, which is why it is worth reading the rule rather than the word: a
       * dock section and an overlay are chrome the shell owns and lends out,
       * while a pane is a place in the tree the user splits, focuses, closes and
       * comes back to after a relaunch. It is for a surface with a subject —
       * this PR, this diff, this log — and never for a panel of controls, which
       * is what the other two are for. See ADR 0044.
       */
      readonly surface?: 'dock' | 'overlay' | 'pane';
      /**
       * The accelerator that raises it, in Electron's vocabulary
       * (`CmdOrCtrl+T`). **A modifier is required** — a bare key here would be
       * deleted from every terminal in the app, which is v1's menu-accelerator
       * lesson. Ignored for a `dock` view, which is always on screen.
       */
      readonly key?: string;
      /**
       * The verb `key` runs, for a `pane` surface.
       *
       * An overlay's key raises the overlay, which needs no verb — the shell
       * owns that layer and toggling it is the whole action. A pane's cannot
       * work that way: opening one usually means minting the SUBJECT it will
       * show first, and nothing can rewrite a pane's `view.state` afterwards.
       * So the key runs a command, and the command opens the pane with the
       * subject already in hand.
       *
       * Ignored without a `key`, and ignored for `dock` and `overlay`.
       */
      readonly command?: string;
      /** Shown as the section/card heading. Falls back to the view type. */
      readonly title?: string;
      /**
       * The glyph on the control that raises an overlay, named from the shell's
       * allow-list. Defaults to `plus`.
       *
       * Not decoration: every raisable overlay drew the same `+`, so a settings
       * form and a composer were two identical buttons side by side and the only
       * way to tell them apart was to press one. A name rather than a component,
       * for the reason every other contributed glyph is (ADR 0033).
       */
      readonly icon?: string;
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
 * What a PANE view is handed — `ExtensionViewProps` plus the two things only a
 * pane has.
 *
 * Its own type for the reason `ExtensionRowProps` is: the extra fields are
 * meaningless anywhere else, and widening the shared type would offer a dock
 * section a `focused` that is always true and a `state` that is always
 * undefined. It EXTENDS rather than duplicates, because a pane genuinely is a
 * view — it invokes commands and it can be finished with (`done()` closes the
 * pane, which is the honest reading of "I am finished" for something that owns a
 * leaf).
 *
 * `focused` is passed rather than derived for ADR 0035's reason: focus is the
 * shell's answer, taken from the snapshot it draws the grid from, and a pane
 * keeping its own copy is the second copy that ADR exists to prevent. It matters
 * more here than for a row — a pane binds keys (Esc, ⌘⇧], a letter), and a
 * background pane that still answered them would fight the one you are looking
 * at.
 */
export interface ExtensionPaneProps extends ExtensionViewProps {
  /** What this pane was opened to show. `unknown`: it crossed a port. */
  readonly state: unknown;
  /** The user is on this pane. Bind keys only while true. */
  readonly focused: boolean;
  /**
   * Which leaf this is.
   *
   * A pane that can be asked about before it closes has to be able to NAME
   * itself: the shell holds the claims and the claim has to say which pane it
   * belongs to. `state` cannot answer that — it is the subject, which two panes
   * showing the same PR would share.
   */
  readonly paneId: string;
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

/**
 * What a row component is handed — deliberately NOT `ExtensionViewProps`.
 *
 * A view owns a panel and decides when it is finished; a row owns one entry in
 * somebody else's list and never is. Handing a row `done()` would offer it a
 * gesture with no meaning here, and sharing one props type would make the two
 * contracts drift toward each other until neither said anything.
 *
 * `selected` is passed rather than derived because selection is the SHELL's
 * answer, taken from the same snapshot value it draws the stage from (ADR 0035).
 * A row that kept its own copy of "am I the one on screen" is the second copy
 * that ADR exists to prevent, and it has been written twice already.
 */
export interface ExtensionRowProps {
  /** The item as contributed, `data` included and still `unknown`. */
  readonly item: TreeItem;
  /** True when the shell is currently showing what this row stands for. */
  readonly selected: boolean;
  invoke(command: string, args?: unknown): Promise<Result<unknown, ViewInvokeError>>;
}

export interface TreeItem {
  readonly id: string;
  readonly label: string;
  /**
   * A heading rather than a row — drawn as a sentence-case micro-label with its
   * `description` as the count, and not clickable.
   *
   * Generic on purpose: grouping a list under headings is what every real
   * sidebar does (tasks by state, channels by workspace, PRs by repo), and the
   * alternative is each extension faking one with a row that lies about being
   * clickable.
   */
  readonly section?: boolean;
  /**
   * This heading sits INSIDE the one above it — drawn a step quieter, with no
   * rule of its own.
   *
   * Depth, not styling. An extension says "this groups rows that are already
   * grouped" and the shell decides what a nested heading looks like; §7's rule
   * that a contribution supplies data and a token name is what keeps a `rule` or
   * a `color` field off this interface.
   *
   * Two levels is the whole of it, because two is what a rail can carry: the
   * outer heading names the region and the inner one partitions it. A third
   * would be a tree, and a tree in a 332px column is an outline nobody reads.
   *
   * Meaningless without `section`, and ignored there rather than refused — a
   * contribution that sets it on an ordinary row gets an ordinary row, which is
   * the same failure mode `component` already has.
   */
  readonly subsection?: boolean;
  /**
   * This row, and everything a contribution sends after it, sits at the physical
   * FOOT of the list rather than merely last in it.
   *
   * Declared rather than inferred. The dock used to pin everything after the last
   * heading, which reads as "the last group is the finished one" and is only true
   * for a tree whose last group happens to be finished work — `tasks` ends on a
   * `Resting` heading with a plain count row under it, so its LIVE work was the
   * thing nailed to the bottom of the sidebar with empty space above it.
   *
   * It says a position, not a meaning: the dock still does not know what "done"
   * is, and a contribution that never sets this simply flows from the top.
   */
  readonly foot?: boolean;
  readonly description?: string;
  /**
   * This row is a CONTROL on the list rather than an entry in it — draw it as
   * chrome.
   *
   * `Show all 28` was the loudest pixel in the rail: an ordinary row, so body
   * type at full `text` ink, sitting under eight shipped tasks drawn at
   * `textGhost` and above nothing at all. It outshone the task the user was
   * mid-turn on. The ink ramp already had the right answer written down —
   * `textFaint`'s job is "a control at rest" — and the search field one row up
   * already quotes that rule to sit a step under the rows. This is the same
   * claim, declared instead of assumed.
   *
   * Orthogonal to `section`: a heading is not clickable and this is, which is
   * exactly why it cannot be one. A quiet row keeps every other row property —
   * the height, the leading slot, the hover fill, the keyboard semantics — and
   * changes only how loudly it speaks.
   */
  readonly quiet?: boolean;
  /**
   * This row is in a region with **no state column** — draw it without the leading
   * slot rather than reserving an empty one.
   *
   * The rail normally reserves that box on every row so a label's x cannot depend on
   * whether its row has a status. Where a whole region's state is declared once by
   * the heading over it — `Shipped`, whose rows all shipped — the box is 21px of
   * indent paid for a column that is always empty, and the region reads better with
   * its heading, its labels and its rows sharing one left edge.
   *
   * **The extension declares it because only the extension can.** Whether a list has
   * a state column is a fact about a row's SIBLINGS: the same `… +3` control is right
   * to reserve the box among tab rows that carry marks and wrong to reserve it among
   * shipped rows that do not, and the shell sees one row at a time.
   *
   * Absent means the slot is reserved, so every tree that has never heard of this is
   * drawn exactly as before.
   */
  readonly gutter?: boolean;
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
  /**
   * This row opens something, and right now it is shut.
   *
   * Drawn today on a `foot` row only, where the dock turns it into a chevron in
   * the leading slot and reads `description` as the count beside it — the shape
   * "finished work leaves the list and becomes a count at the foot" asks for.
   * Elsewhere it is still declaration-only: the dock draws no nested children,
   * so a chevron on an ordinary row would promise an expansion nothing performs.
   *
   * Absent means the row opens nothing. That is not the same as `false`, which
   * means it opens something and is currently open.
   */
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
   * The row DRAWS ITSELF, by name — the same seam a contributed view uses
   * (§7b, ADR 0033), one level down.
   *
   * The row grammar carries a label, a description, a mark and a count, and that
   * is deliberately most of what a rail row should ever be. But Shepherd UI's
   * waiting-on-you card carries a question, two answers, a diff line, a suite
   * meter and a set of repo chips — and §5 is explicit that this one case is
   * allowed to change size while everything else stays a fixed-height row.
   *
   * The alternative was a typed `card` field on this interface carrying all of
   * it. That was rejected: every future card shape would widen the kernel's own
   * vocabulary, and the kernel would end up knowing what a suite meter is. A
   * NAME keeps the shape where the shape belongs — in the extension that has the
   * data — and keeps this interface the size it is.
   *
   * What it does NOT buy is freedom. The name resolves against a static table in
   * the renderer build, exactly as a view's does, so an extension can ask for a
   * component and cannot supply one. An unknown name draws the ordinary row,
   * which is the correct failure: the row still says what it stands for and is
   * still clickable, it just does not have its richer form.
   *
   * `label`, `tint` and `command` stay required-shaped and stay honest even with
   * a component set. They are what a remote member draws in its own sidebar,
   * what the row is announced as, and what happens when it is clicked — and none
   * of those may depend on a renderer this client might not be.
   */
  readonly component?: string;
  /**
   * The component's props, opaque to the shell.
   *
   * It crosses an IPC port, so it is `unknown` on arrival and the component
   * reads it defensively — `ok` says a call succeeded, never that a value has a
   * shape. A component that casts this is one bad extension away from a renderer
   * crash, and the renderer is the whole window.
   */
  readonly data?: unknown;
  /**
   * The verb that ANSWERS what this row stands for, and does nothing else.
   *
   * `command` is a gesture: `tasks.reveal` opens a layout root and switches the
   * window to it. That is right for the machine the row lives on and wrong for
   * every other client of the same core — **another member of the net drawing
   * this row in its own sidebar wants to become a second viewer of the session,
   * not to move somebody else's window.** So a row may declare a second verb that
   * reports a `PresentEffect` and performs no local gesture, and a client with a
   * surface of its own calls that instead.
   *
   * Declared by the extension and attributed to it exactly as `command` is (M3
   * D14), and carried by the shell without being interpreted — a shell that
   * recovered the intent by matching command ids (`if (id === 'tasks.reveal')
   * attach(...)`) would have hardcoded `tasks` after all, which is the special
   * case ADR 0031 exists to prevent.
   *
   * **A verb rather than the effect itself, because liveness is a moment.** A row
   * is drawn once and the session it names can exit before anybody clicks it;
   * `tasks.reveal` already carries the scar — presenting a recorded session id
   * without checking it told a phone to open a terminal that could never paint,
   * and nothing reported a fault because nothing had failed. A verb re-checks at
   * click time. A field would be that bug with a longer fuse.
   *
   * Absent means "there is nothing this row can be shown as elsewhere", and a
   * remote client then does nothing and says so. It must NOT fall back to
   * `command`, which would run the gesture on the wrong machine.
   */
  readonly presents?: { readonly id: string; readonly args?: unknown };
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
  /**
   * The row's ONE verb worth a control of its own — drawn in the trailing slot,
   * revealed on hover and on keyboard focus within the row.
   *
   * `Row` has had that slot since it shipped (its rule 4: "the trailing area is
   * a 1-cell grid … a hover ACTION in every row that wants one"); what was
   * missing was any way for a CONTRIBUTED row to declare into it. `command` is
   * the row's click, `presents` its read-only twin, `actions` its menu — and
   * none of them is "the thing you do to this row most, worth a button".
   *
   * Declared by the extension for the reason `actions` is: the shell cannot know
   * a row's verbs, and a sidebar that hardcoded a checkmark would be a sidebar
   * that knows what a task is (ADR 0031). **Attributed to the CONTRIBUTING
   * EXTENSION, never to the user** (M3 D14) — the click is genuinely the user's,
   * the command id behind it is not, and they cannot see it. It travels the same
   * seam a row's click does, so there is one attribution rule rather than two
   * that must agree.
   *
   * **Singular on purpose.** A row with three hover buttons is a toolbar, and
   * `actions` already exists for the rest. `label` is required for `IconButton`'s
   * reason: an icon-only control has no accessible name, and this one is icon-
   * only by construction.
   *
   * A client with another surface may draw it as a swipe, a button, or not at
   * all — it is a field on a row, not a desktop gesture.
   */
  readonly primaryAction?: {
    readonly id: string;
    readonly label: string;
    /** A glyph NAME, resolved by the renderer against its own set. Never an SVG. */
    readonly icon?: string;
    readonly args?: unknown;
    /**
     * Ask this first. Absent means run immediately.
     *
     * The extension writes the QUESTION and the shell asks it, for the same
     * reason a row's verbs are declared rather than known (ADR 0031): only the
     * extension can tell whether this particular invocation is the risky one, and
     * only the shell has a surface to ask on. An extension cannot raise a dialog
     * itself — its service half runs in a utility process with no DOM.
     *
     * A STRING rather than a boolean, because "are you sure?" is not worth
     * interrupting anybody for. What makes a confirm useful is naming the
     * consequence, and only the caller knows it.
     *
     * Conditional by nature: the same button on two rows may carry it on one and
     * not the other. `tasks` sets it on Ship only when an agent is mid-turn,
     * because that is when shipping kills something that was working.
     */
    readonly confirm?: string;
  };
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
  /** Ask this first — see `TreeItem.primaryAction.confirm`. */
  readonly confirm?: string;
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
