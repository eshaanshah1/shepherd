import { paneId } from '@shepherd/sdk';
import type { RandomId } from '../identity.ts';
import { makePane, type Pane } from './pane.ts';
import { clampRatio, leaf, split, type SplitAxis, type SplitNode } from './tree.ts';

/**
 * The persisted shape, spelled out as its own type.
 *
 * v1 persisted by giving `Pane` a `Codable` conformance with a hand-written
 * `CodingKeys` listing the three fields that survive — which works, and which
 * silently starts persisting a new field the day somebody adds it to the enum.
 * Here the DTO is a separate type: a new field on `Pane` cannot reach disk
 * unless someone writes it into `serializePane` on purpose, and the compiler
 * says nothing either way. That is the point — `initialCommand` is exactly the
 * field that must never round-trip (it re-runs a command on every relaunch),
 * and `title` is live output from a program that is no longer running.
 *
 * **The pane id IS persisted, since R1** (ADR 0036), reversing the rule that
 * stood here for three milestones: "a restored pane is a new pane showing an old
 * directory; reusing the id would let a stale session id, a stale attention entry
 * or a stale extension record survive a relaunch and address it."
 *
 * That was right while sessions died with the app — there was nothing to reattach
 * to, so a fresh id was pure upside. With `shepherdd` holding the ptys it becomes
 * the bug: fresh ids mean each restored pane creates a SECOND session while the
 * daemon's original keeps running with nothing pointing at it, invisible and
 * unkillable. The milestone would orphan agents instead of preserving them.
 *
 * What makes reuse safe is the thing that made it necessary: the daemon is the
 * authority on what is alive, so a restored `sessionId` is a CLAIM, verified
 * against its inventory before it is believed (`LayoutStore.#restore`). Stale
 * bindings still fail — they fail by being checked rather than by being
 * impossible, and that check could not exist before.
 *
 * `initialCommand` still must never round-trip: a reattached pane that re-ran its
 * command would start a second agent inside a pane that already has one.
 */
export interface PersistedPane {
  readonly userTitle?: string;
  readonly cwd?: string;
  /** Stable across a relaunch, so a session can be found again. */
  readonly id?: string;
  /** What this pane was showing. A claim, not a fact — see above. */
  readonly sessionId?: string;
}

export type PersistedNode =
  | { readonly kind: 'leaf'; readonly pane: PersistedPane }
  | {
      readonly kind: 'split';
      readonly axis: SplitAxis;
      readonly ratio: number;
      readonly first: PersistedNode;
      readonly second: PersistedNode;
    };

export function serializePane(pane: Pane, sessionId?: string): PersistedPane {
  const out: { userTitle?: string; cwd?: string; id?: string; sessionId?: string } = {};
  if (pane.userTitle !== null && pane.userTitle !== '') out.userTitle = pane.userTitle;
  if (pane.cwd !== null && pane.cwd !== '') out.cwd = pane.cwd;
  out.id = pane.id;
  if (sessionId !== undefined && sessionId !== '') out.sessionId = sessionId;
  return out;
}

/** `sessionOf` answers what a pane was showing; absent = it was showing nothing. */
export function serializeNode(node: SplitNode, sessionOf?: (pane: Pane) => string | undefined): PersistedNode {
  return node.kind === 'leaf'
    ? { kind: 'leaf', pane: serializePane(node.pane, sessionOf?.(node.pane)) }
    : {
        kind: 'split',
        axis: node.axis,
        ratio: node.ratio,
        first: serializeNode(node.first, sessionOf),
        second: serializeNode(node.second, sessionOf),
      };
}

export class LayoutDecodeError extends Error {
  constructor(message: string) {
    super(`layout: ${message}`);
    this.name = 'LayoutDecodeError';
  }
}

/**
 * Rebuild a tree from disk, KEEPING each leaf's persisted id (ADR 0036).
 *
 * A record written before R1 carries no id, so one is minted — which is the old
 * behaviour, and correct: there is no session to find again either.
 *
 * Validates as it goes rather than trusting a cast: this reads a JSON file the
 * user (or a half-finished write) can have mangled, and a tree with an
 * undefined `axis` renders as a blank window with no error anywhere.
 */
export function deserializeNode(value: unknown, random?: RandomId): SplitNode {
  const node = asRecord(value, 'node');
  const kind = node['kind'];
  if (kind === 'leaf') {
    const pane = asRecord(node['pane'] ?? {}, 'pane');
    const persistedId = optionalString(pane['id'], 'pane.id');
    return leaf(
      makePane(
        {
          userTitle: optionalString(pane['userTitle'], 'pane.userTitle'),
          cwd: optionalString(pane['cwd'], 'pane.cwd'),
          ...(persistedId === null ? {} : { id: paneId(persistedId) }),
        },
        random,
      ),
    );
  }
  if (kind === 'split') {
    const axis = node['axis'];
    if (axis !== 'row' && axis !== 'column') {
      throw new LayoutDecodeError(`unknown axis ${JSON.stringify(axis)}`);
    }
    const ratio = node['ratio'];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
      throw new LayoutDecodeError(`ratio must be a finite number, got ${JSON.stringify(ratio)}`);
    }
    return split(
      axis,
      clampRatio(ratio),
      deserializeNode(node['first'], random),
      deserializeNode(node['second'], random),
    );
  }
  throw new LayoutDecodeError(`unknown node kind ${JSON.stringify(kind)}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LayoutDecodeError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new LayoutDecodeError(`${what} must be a string`);
  return value;
}
