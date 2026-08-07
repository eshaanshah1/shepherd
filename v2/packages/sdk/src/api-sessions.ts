import type { Disposable } from './disposable.ts';
import type { NodeID, SessionID } from './ids.ts';
import type { Result } from './result.ts';

/**
 * Sessions, as an extension sees them (core-design §4.1).
 *
 * The one invariant worth restating at the type level: **a session is not a
 * view.** Nothing here creates or destroys a session as a side effect of
 * something happening to a surface. `attach` hands back a `Disposable`, and
 * disposing it detaches a reader — it does not end anything. v1's root bug was
 * the opposite arrangement, and the whole rebuild rests on this line.
 */

export type Env = Readonly<Record<string, string>>;

export interface SessionCreateOptions {
  readonly cwd: string;
  /** argv. Absent means the platform's login shell. */
  readonly command?: readonly string[];
  readonly env?: Env;
  readonly cols?: number;
  readonly rows?: number;
  /** Where to put a view of it. Absent creates a session with no surface. */
  readonly location?: LayoutTarget;
}

/** Where a view goes. A session with no target is headless — that is legal. */
export type LayoutTarget =
  | { readonly kind: 'node'; readonly nodeId: NodeID }
  | { readonly kind: 'region'; readonly region: RegionName }
  | { readonly kind: 'split'; readonly nodeId: NodeID; readonly axis: 'row' | 'column' };

/**
 * The window's frame. `main` is the grid; the docks are where view stacks live.
 * There is **no core-owned sidebar** — "the sidebar" is whatever sits in
 * `leftDock`, and the default task list is an extension view like any other.
 */
export const REGIONS = ['main', 'leftDock', 'rightDock', 'bottomDock', 'statusBar'] as const;
export type RegionName = (typeof REGIONS)[number];

export interface SessionMeta {
  /** Typed per-extension attachments, persisted with the session. */
  get<T>(namespace: string, key: string): T | undefined;
  set<T>(namespace: string, key: string, value: T): void;
  delete(namespace: string, key: string): void;
}

/** A live byte stream. Disposing it detaches; the session is untouched. */
export interface Attachment extends Disposable {
  readonly sessionId: SessionID;
  onData(fn: (bytes: Uint8Array) => void): Disposable;
}

export interface Session {
  /** THE correlation key — IPC, hooks, remote, logs. */
  readonly id: SessionID;
  readonly cwd: string;
  readonly pid: number;
  /** Raw input. A newline here IS an Enter press. */
  write(data: string | Uint8Array): void;
  /** Multi-line text with paste semantics — see the v1 gotcha this preserves. */
  paste(text: string): void;
  /** Ring replay, then live bytes, with no gap and no duplicate. */
  attach(opts?: { readonly replay?: boolean }): Attachment;
  /** Only an authorized caller resizes: a viewer is not a resizer. */
  resize(cols: number, rows: number): void;
  /** The liveness reconciler's input — "state says working, is anything running?" */
  hasForegroundProcess(): Promise<boolean>;
  kill(signal?: string): void;
  readonly meta: SessionMeta;
}

/** The draft an `onWillCreate` hook may patch — the env-injection seam. */
export interface SessionDraft {
  readonly sessionId: SessionID;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly env: Env;
}

export interface SessionAPI {
  create(opts: SessionCreateOptions): Promise<Result<Session, string>>;
  get(id: SessionID): Session | undefined;
  list(): readonly Session[];
  /**
   * Fires before the pty is spawned, so a returned env actually reaches the
   * child. This is the correlation seam ADR 0003 established: `claude-code`
   * injects the session id and the ingress socket path here, and correlation is
   * therefore by env var rather than by guessing at a pid.
   */
  onWillCreate(fn: (draft: SessionDraft) => { readonly env?: Env } | void): Disposable;
  onDidCreate(fn: (session: Session) => void): Disposable;
  onDidExit(fn: (session: SessionID, code: number) => void): Disposable;
}
