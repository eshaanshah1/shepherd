import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { PaneID } from '@shepherd/sdk';
import {
  clampRatio,
  dividerKey,
  displayTitle,
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
 *   - **The tree.** `tree` is main's, and this view never produces a new one. A
 *     gesture is a *command* (`onFocusPane`, `onSetRatio`) that the kernel
 *     applies; the changed tree comes back as the next snapshot. That is the
 *     "mutations through one normalizing funnel" rule with the funnel now a
 *     process away — and it is why ⌘D, this view, and `shepherd pane split`
 *     cannot come to mean different things.
 *   - **Sessions.** A leaf renders whatever `renderPane` returns, and the view's
 *     mount/unmount neither creates nor kills anything — the session registry is
 *     keyed by pane id and the pty lives in main.
 *
 * The one piece of state it does own is the **drag preview**, and that is
 * finding F: a `layout.setRatio` per mousemove would be a 60Hz IPC storm into the
 * one funnel with a debounced sqlite write behind it. So a drag paints locally and
 * commits exactly once, on mouse-up.
 */

export interface SplitViewProps {
  readonly tree: SplitNode;
  /** One command per completed drag. Never called per mousemove — see `Preview`. */
  readonly onSetRatio?: (path: readonly number[], ratio: number) => void;
  readonly focusedPaneId?: string | null;
  readonly onFocusPane?: (id: PaneID) => void;
  readonly renderPane?: (pane: Pane, focused: boolean) => ReactNode;
  /** For `displayTitle`'s `~` shortening; the renderer has no `os.homedir()`. */
  readonly home?: string;
}

/** Which divider is mid-drag, and where the user has dragged it to. */
interface Preview {
  readonly key: string;
  readonly ratio: number;
}

interface Ctx {
  readonly focusedPaneId: string | null;
  readonly onFocusPane: ((id: PaneID) => void) | undefined;
  readonly renderPane: ((pane: Pane, focused: boolean) => ReactNode) | undefined;
  readonly preview: Preview | null;
  readonly onPreview: (path: readonly number[], ratio: number) => void;
  readonly onCommit: (path: readonly number[], ratio: number) => void;
  readonly home: string;
}

const ROOT_PATH: readonly number[] = [];

export function SplitView(props: SplitViewProps): ReactNode {
  const { tree, onSetRatio } = props;
  const [preview, setPreview] = useState<Preview | null>(null);

  // The preview is dropped when a NEW TREE arrives, not on mouse-up. Between
  // releasing the mouse and the snapshot coming back there is a round trip
  // through main, and clearing early makes the divider snap to its old position
  // for a frame or two — which reads as the drag having been rejected.
  useEffect(() => setPreview(null), [tree]);

  const onPreview = useCallback((path: readonly number[], ratio: number) => {
    // Clamped with core's own `clampRatio`, which is the function `setRatio`
    // applies. Not a second opinion about what is legal — the same one, so what
    // you drag is what you get and the preview cannot show a pane of no width.
    setPreview({ key: dividerKey(path), ratio: clampRatio(ratio) });
  }, []);

  const onCommit = useCallback(
    (path: readonly number[], ratio: number) => {
      // Already clamped, for the same reason: the committed value is the value
      // the user was looking at when they let go.
      onSetRatio?.(path, clampRatio(ratio));
    },
    [onSetRatio],
  );

  const ctx: Ctx = {
    focusedPaneId: props.focusedPaneId ?? null,
    onFocusPane: props.onFocusPane,
    renderPane: props.renderPane,
    preview,
    onPreview,
    onCommit,
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
 *
 * The `key`s are finding G: a leaf is keyed by its **pane id**, a split by its
 * path, so React's identity for a node is structural rather than positional.
 * Every snapshot arrives as a freshly structure-cloned tree, so positional
 * identity is the only thing standing between a reshape and a churn of everything
 * below it. What it cannot do is keep a component mounted across a change of
 * DEPTH — splitting a leaf makes it a grandchild, and React must remount it.
 * That is why the terminal is owned by `PaneSessionRegistry` and not by the view:
 * a remount costs one `appendChild` and no xterm, which `app.test.tsx` asserts by
 * counting terminals built.
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
    <PaneLeaf key={`pane:${node.pane.id}`} pane={node.pane} ctx={ctx} />
  ) : (
    <SplitBranch key={`split:${dividerKey(path)}`} node={node} path={path} ctx={ctx} />
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
  // The dragged ratio if this is the divider being dragged, else the tree's.
  const ratio = ctx.preview?.key === dividerKey(path) ? ctx.preview.ratio : node.ratio;

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
      <div className="sh-split-child" data-testid="split-child" data-slot="first" style={share(ratio)}>
        <NodeView node={node.first} path={[...path, 0]} ctx={ctx} />
      </div>
      <PaneDivider
        path={path}
        axis={node.axis}
        containerRef={container}
        onPreview={ctx.onPreview}
        onCommit={ctx.onCommit}
      />
      <div className="sh-split-child" data-testid="split-child" data-slot="second" style={share(1 - ratio)}>
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
  /** Per mousemove. Local paint only — never a command. */
  readonly onPreview: (path: readonly number[], ratio: number) => void;
  /** Once, on mouse-up, and only if the drag actually moved. */
  readonly onCommit: (path: readonly number[], ratio: number) => void;
}

/**
 * One draggable hairline. Mouse events rather than pointer events on purpose:
 * a pointer capture on the divider would keep working, but plain mouse events
 * are what jsdom implements, and a drag nobody can test is a drag that breaks.
 */
export function PaneDivider({
  path,
  axis,
  containerRef,
  onPreview,
  onCommit,
}: PaneDividerProps): ReactNode {
  const dragging = useRef(false);
  /** The last ratio the mouse produced. What mouse-up commits. */
  const pending = useRef<number | null>(null);

  const ratioAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      const el = containerRef.current;
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      const span = axis === 'row' ? rect.width : rect.height;
      // An unmeasured container (display:none, or a test that forgot to give
      // the element a size) would divide by zero and hand `clampRatio` a NaN,
      // which stays NaN and renders a pane of no width. Refuse instead.
      if (!(span > 0)) return null;
      const offset = axis === 'row' ? clientX - rect.left : clientY - rect.top;
      return offset / span;
    },
    [axis, containerRef],
  );

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (dragging.current) return;
      dragging.current = true;
      pending.current = null;

      const move = (e: MouseEvent): void => {
        if (!dragging.current) return;
        const ratio = ratioAt(e.clientX, e.clientY);
        if (ratio === null) return;
        pending.current = ratio;
        onPreview(path, ratio);
      };
      const up = (): void => {
        dragging.current = false;
        globalThis.removeEventListener('mousemove', move);
        globalThis.removeEventListener('mouseup', up);
        globalThis.document.body.classList.remove('sh-dragging');
        // ONE command per drag. A press with no movement commits nothing: it is
        // a click on a hairline, and turning it into a `setRatio` would put a
        // no-op through the funnel and a write behind it.
        const ratio = pending.current;
        pending.current = null;
        if (ratio !== null) onCommit(path, ratio);
      };

      // Listeners on the window, not the divider: the cursor outruns a 1px
      // strip on the first fast drag and the pane would stick mid-move.
      globalThis.addEventListener('mousemove', move);
      globalThis.addEventListener('mouseup', up);
      globalThis.document.body.classList.add('sh-dragging');
    },
    [path, ratioAt, onPreview, onCommit],
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
 * What sits where the terminal will. This is deliberately a card and not an empty
 * box: an empty box cannot show you that the pane it is in has the right size or
 * the right identity, which is exactly what a layout test needs to see.
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
