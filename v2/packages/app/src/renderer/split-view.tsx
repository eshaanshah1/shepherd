import {
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { PaneID } from '@shepherd/sdk';
import {
  dividerKey,
  displayTitle,
  setRatio,
  type Pane,
  type SplitAxis,
  type SplitNode,
} from '@shepherd/core/layout';

/**
 * The pane tree, drawn.
 *
 * Three things this view deliberately does NOT own:
 *
 *   - **Geometry.** A split's children get `flexGrow: ratio` / `1 - ratio` and
 *     flex does the arithmetic, so the browser's layout and `frames()` are the
 *     same function of the same numbers. Positioning panes absolutely from
 *     `frames()` would be a second layout engine racing the first.
 *   - **The tree.** Every mutation goes out through `onTreeChange` as a NEW
 *     tree from a core op; nothing here writes to `props.tree`. That is the
 *     "read-only tree, mutations through one normalizing funnel" rule, and it
 *     is why a drag can be replayed in a test by calling the same op.
 *   - **Sessions.** A leaf renders whatever `renderPane` returns. In P3 that is
 *     a placeholder; when xterm arrives it becomes a terminal view, and the
 *     view's mount/unmount still must not create or kill anything — the session
 *     registry is keyed by pane id in the main process.
 */

export interface SplitViewProps {
  readonly tree: SplitNode;
  /** Called with the new tree after any layout gesture. Never mutates `tree`. */
  readonly onTreeChange: (next: SplitNode) => void;
  readonly focusedPaneId?: PaneID | null;
  readonly onFocusPane?: (id: PaneID) => void;
  readonly renderPane?: (pane: Pane, focused: boolean) => ReactNode;
  /** For `displayTitle`'s `~` shortening; the renderer has no `os.homedir()`. */
  readonly home?: string;
}

interface Ctx {
  readonly focusedPaneId: PaneID | null;
  readonly onFocusPane: ((id: PaneID) => void) | undefined;
  readonly renderPane: ((pane: Pane, focused: boolean) => ReactNode) | undefined;
  readonly onRatio: (path: readonly number[], ratio: number) => void;
  readonly home: string;
}

const ROOT_PATH: readonly number[] = [];

export function SplitView(props: SplitViewProps): ReactNode {
  const { tree, onTreeChange } = props;

  const onRatio = useCallback(
    (path: readonly number[], ratio: number) => {
      // The one place a drag becomes a tree — and the ONLY clamp. The divider
      // hands over a raw fraction; `setRatio` decides what is legal, exactly as
      // it does for a scripted layout change. A second clamp in the view would
      // read as belt-and-braces and act as a second opinion about the model's
      // invariants, which is how the two drift.
      onTreeChange(setRatio(tree, path, ratio));
    },
    [tree, onTreeChange],
  );

  const ctx: Ctx = {
    focusedPaneId: props.focusedPaneId ?? null,
    onFocusPane: props.onFocusPane,
    renderPane: props.renderPane,
    onRatio,
    home: props.home ?? '',
  };

  return (
    <div className="sh-split-root" data-testid="split-root">
      <NodeView node={tree} path={ROOT_PATH} ctx={ctx} />
    </div>
  );
}

/**
 * Dispatch only — no hooks. A node can change from leaf to split in place when
 * a pane is split, and a component that called `useRef` after an early return
 * would change its hook count under React at exactly that moment.
 */
function NodeView({
  node,
  path,
  ctx,
}: {
  node: SplitNode;
  path: readonly number[];
  ctx: Ctx;
}): ReactNode {
  return node.kind === 'leaf' ? (
    <PaneLeaf pane={node.pane} ctx={ctx} />
  ) : (
    <SplitBranch node={node} path={path} ctx={ctx} />
  );
}

function SplitBranch({
  node,
  path,
  ctx,
}: {
  node: Extract<SplitNode, { kind: 'split' }>;
  path: readonly number[];
  ctx: Ctx;
}): ReactNode {
  const container = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={container}
      className="sh-split"
      data-testid="split"
      data-axis={node.axis}
      data-split-path={dividerKey(path)}
      // ADR 0012's vocabulary: `row` is a ROW OF PANES — side by side, with a
      // vertical hairline between them. Read it off the tree module, not the word.
      style={{ flexDirection: node.axis === 'row' ? 'row' : 'column' }}
    >
      <div className="sh-split-child" data-testid="split-child" data-slot="first" style={share(node.ratio)}>
        <NodeView node={node.first} path={[...path, 0]} ctx={ctx} />
      </div>
      <PaneDivider path={path} axis={node.axis} containerRef={container} onRatio={ctx.onRatio} />
      <div className="sh-split-child" data-testid="split-child" data-slot="second" style={share(1 - node.ratio)}>
        <NodeView node={node.second} path={[...path, 1]} ctx={ctx} />
      </div>
    </div>
  );
}

/**
 * A child's share of its parent. `flexBasis: 0` with a fractional `flexGrow` is
 * what makes the two children divide the space *after* the hairline is taken
 * out — percentage bases would sum to 100% plus a pixel and overflow.
 * `minWidth/minHeight: 0` is the flexbox trap: without it a child refuses to
 * shrink below its content and a busy pane pushes its sibling off the edge.
 */
function share(grow: number): CSSProperties {
  return { flexGrow: grow, flexBasis: 0, flexShrink: 1, minWidth: 0, minHeight: 0 };
}

export interface PaneDividerProps {
  readonly path: readonly number[];
  readonly axis: SplitAxis;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly onRatio: (path: readonly number[], ratio: number) => void;
}

/**
 * One draggable hairline. Mouse events rather than pointer events on purpose:
 * a pointer capture on the divider would keep working, but plain mouse events
 * are what jsdom implements, and a drag nobody can test is a drag that breaks.
 */
export function PaneDivider({ path, axis, containerRef, onRatio }: PaneDividerProps): ReactNode {
  const dragging = useRef(false);

  const ratioAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      const el = containerRef.current;
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      const span = axis === 'row' ? rect.width : rect.height;
      // An unmeasured container (display:none, or a test that forgot to give
      // the element a size) would divide by zero and hand `setRatio` a NaN,
      // which clamps to NaN and renders a pane of no width. Refuse instead.
      if (!(span > 0)) return null;
      const offset = axis === 'row' ? clientX - rect.left : clientY - rect.top;
      // Raw, deliberately: `setRatio` owns the clamp (see `onRatio`).
      return offset / span;
    },
    [axis, containerRef],
  );

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (dragging.current) return;
      dragging.current = true;

      const move = (e: MouseEvent): void => {
        if (!dragging.current) return;
        const ratio = ratioAt(e.clientX, e.clientY);
        if (ratio !== null) onRatio(path, ratio);
      };
      const up = (): void => {
        dragging.current = false;
        globalThis.removeEventListener('mousemove', move);
        globalThis.removeEventListener('mouseup', up);
        globalThis.document.body.classList.remove('sh-dragging');
      };

      // Listeners on the window, not the divider: the cursor outruns a 1px
      // strip on the first fast drag and the pane would stick mid-move.
      globalThis.addEventListener('mousemove', move);
      globalThis.addEventListener('mouseup', up);
      globalThis.document.body.classList.add('sh-dragging');
    },
    [path, ratioAt, onRatio],
  );

  return (
    <div
      className="sh-divider"
      data-testid="divider"
      data-divider-key={dividerKey(path)}
      data-axis={axis}
      role="separator"
      aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
    />
  );
}

function PaneLeaf({ pane, ctx }: { pane: Pane; ctx: Ctx }): ReactNode {
  const focused = ctx.focusedPaneId === pane.id;
  return (
    <div
      className="sh-pane"
      data-testid="pane"
      data-pane-id={pane.id}
      data-focused={focused ? 'true' : 'false'}
      onMouseDown={() => ctx.onFocusPane?.(pane.id)}
    >
      {ctx.renderPane === undefined ? (
        <PanePlaceholder pane={pane} home={ctx.home} />
      ) : (
        ctx.renderPane(pane, focused)
      )}
    </div>
  );
}

/**
 * What sits where the terminal will. P3 proves the layout before a PTY is
 * attached to it, so this is deliberately a card and not an empty box: an empty
 * box cannot show you that the pane it is in has the right size or the right
 * identity.
 */
function PanePlaceholder({ pane, home }: { pane: Pane; home: string }): ReactNode {
  return (
    <div className="sh-pane-body">
      <div className="sh-pane-title">{displayTitle(pane, home)}</div>
      <div className="sh-pane-meta">{pane.id.slice(0, 8)}</div>
      <div className="sh-pane-hint">no session attached</div>
    </div>
  );
}
