// The layout tree — a direct port of spike/seam1/Sources/SplitTree.swift
// (lines 21-248 plus its two Codable extensions).
//
// Two things were deliberately left behind:
//   - `buildRemoteNode` / `buildMirrorNode` — the wire bridge. That is M2, and
//     it dragged in RemotePane/RemoteNode/RemoteConnState/AgentState, which is
//     how a "dependency-free" file ended up importing four other modules.
//   - `Pane.state` / `reason` / `remote` / `stowing` / `provisioning` — M0 has
//     no agent-state model, and per the core design those live in extensions
//     keyed by pane id, not on the layout node.
//
// Everything here is pure and immutable: no electron, no react, no node-pty,
// no clock, no OS. `grep` for those in this directory should stay empty.

export type { Pane, PaneInit } from './pane.ts';
export { makePane, displayTitle, DEFAULT_PANE_TITLE } from './pane.ts';

export type { SplitAxis, FocusDirection, Rect, SplitNode, SplitDivider, TreeEdit } from './tree.ts';
export {
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
} from './tree.ts';

export type { PersistedPane, PersistedNode } from './serialize.ts';
export { serializePane, serializeNode, deserializeNode, LayoutDecodeError } from './serialize.ts';

export { LayoutStore, type CloseOutcome, type LayoutStoreOptions, type PersistedLayout, type SessionSink } from './store.ts';
export { registerLayoutCommands, LAYOUT_COMMANDS, type LayoutCommandsOptions } from './commands.ts';
