// @shepherd/core — the kernel.
//
// Two directories, both of which the design names:
//   src/layout/   — the SplitTree port. Pure, immutable, platform-free.
//   src/session/  — PtyRing + PtyFanout now; SessionHost (node-pty) in P2.
//
// They are directories rather than packages on purpose: one tsconfig, one
// vitest project, one boundary-lint rule. Splitting them into workspace
// packages would triple the project-reference wiring and buy nothing in M0.
export { newSessionId, newPaneId, type RandomId } from './identity.ts';

export type {
  Pane,
  PaneInit,
  SplitAxis,
  FocusDirection,
  Rect,
  SplitNode,
  SplitDivider,
  TreeEdit,
  PersistedPane,
  PersistedNode,
} from './layout/index.ts';
export {
  makePane,
  displayTitle,
  leaf,
  split,
  leafIds,
  panes,
  firstLeafId,
  findPane,
  containsPane,
  splitPane,
  updatePane,
  setRatio,
  clampRatio,
  frames,
  dividers,
  dividerKey,
  neighbor,
  siblingLeaf,
  closing,
  MIN_RATIO,
  MAX_RATIO,
  serializePane,
  serializeNode,
  deserializeNode,
  LayoutDecodeError,
} from './layout/index.ts';

export {
  PtyRing,
  PtyFanout,
  SessionHost,
  resolveSpec,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_RING_BYTES,
  DEFAULT_TERM,
  type PtySink,
  type ResolvedSpec,
  type SessionError,
  type SessionErrorCode,
  type SessionExit,
  type SessionHostOptions,
  type SessionInfo,
  type SessionSpec,
  type WillCreateEvent,
  type WillCreateHook,
  type WillCreatePatch,
} from './session/index.ts';
