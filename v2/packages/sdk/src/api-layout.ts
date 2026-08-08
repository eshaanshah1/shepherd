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
  | { readonly kind: 'tree'; readonly data: TreeDataProvider }
  | { readonly kind: 'component'; readonly component: string }
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
  readonly description?: string;
  /** A design-token name, resolved by the renderer. Never a raw colour. */
  readonly tint?: string;
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
