import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import type { CategoryLogger } from '@shepherd/sdk';

/**
 * The control channel: a device invoking commands, and nothing else.
 *
 * **It deliberately invents no vocabulary.** §4.3's rule is that keyboard,
 * palette, CLI socket, MCP, remote and extensions are *transports* into one
 * command registry, never six implementations — v1 shipped three
 * (`controlRoute`, `applyRemoteCommand`, `ShortcutActions`) and they drifted.
 * So this carries an `invoke` and the registry does the rest: listing views,
 * reading a tree's rows, and running a row's verb are all just commands.
 *
 * That is also why there is no phone-shaped UI schema here. `TreeItem` already
 * IS a renderer-agnostic description — `tint` is a design-token name and never a
 * colour, `icon` is a glyph name and never an SVG, and a row's verbs are
 * declared by the extension "because the shell cannot know the verbs". A phone
 * is another shell. What was missing was never the description; it was knowing
 * what a tap should SHOW, which is `PresentEffect`.
 *
 * ## Why a device pairs once but connects twice
 *
 * Data goes to the daemon (so a terminal survives the app restarting) and
 * control to the app (which is where extensions, and therefore views, live).
 * Both consult the SAME persisted device store, so the second connection needs
 * no second approval — it presents the secret the first one was issued.
 *
 * And only the app can ever CREATE a pairing, because only the app can show the
 * approval. The daemon never calls `showCode()`, so `pairingDecision` refuses
 * every unknown device there with "no pairing code is active" — which is not a
 * limitation but a property: a headless process cannot admit a stranger.
 */

export const CONTROL = {
  /** Client -> host: run a command. */
  invoke: 140,
  /** Host -> client: the answer, keyed by `seq`. */
  result: 141,
  /** Host -> client: a contributed view's rows changed; ask again. */
  changed: 142,
} as const;

/** What the control channel needs from the host. The app supplies it. */
export interface ControlHost {
  /**
   * Runs `command` attributed to a DEVICE.
   *
   * Attribution is the caller's, not this module's: `caller.kind === 'device'`
   * already exists in the envelope and authorization runs in the dispatcher
   * before any handler (§4.3). A transport that attributed its own calls would
   * be the read-side-only hole the review found, one layer along.
   */
  invoke(deviceId: string, command: string, args: unknown): Promise<unknown>;
}

export interface ControlChannelOptions {
  readonly host: ControlHost;
  readonly log: CategoryLogger;
  /**
   * Commands a device may always invoke, however it arrived.
   *
   * Deliberately tiny: the verbs that let a client DISCOVER what it may do. Any
   * other command has to have been declared on a row the device was actually
   * sent — see `#allowed`.
   */
  readonly discovery?: readonly string[];
}

const DEFAULT_DISCOVERY = ['views.list', 'views.children'] as const;

interface Session {
  readonly deviceId: string;
  /**
   * Command ids this device has been offered on a row.
   *
   * **The capability boundary, and it is free today.** A row's verbs are already
   * declared by the extension that drew it, so "what this device may run" is
   * exactly "what it was shown" — no new permission vocabulary, no per-command
   * grants to maintain. Narrowing this later would break clients; starting wide
   * and tightening is the migration nobody gets to do.
   */
  readonly offered: Set<string>;
}

export class ControlChannel {
  readonly #options: ControlChannelOptions;
  readonly #log: CategoryLogger;
  readonly #sessions = new Map<number, Session>();
  readonly #discovery: ReadonlySet<string>;

  constructor(options: ControlChannelOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#discovery = new Set(options.discovery ?? DEFAULT_DISCOVERY);
  }

  open(connectionId: number, deviceId: string): void {
    this.#sessions.set(connectionId, { deviceId, offered: new Set() });
  }

  close(connectionId: number): void {
    this.#sessions.delete(connectionId);
  }

  /**
   * Handles one control frame. Returns the bytes to write back, or undefined
   * when the frame is not this channel's business.
   */
  async handle(connectionId: number, frame: Frame): Promise<Uint8Array | undefined> {
    if ((frame.kind as number) !== CONTROL.invoke) return undefined;
    const session = this.#sessions.get(connectionId);
    if (session === undefined) return undefined;

    const body = (frame.json ?? {}) as { seq?: number; command?: string; args?: unknown };
    const seq = typeof body.seq === 'number' ? body.seq : -1;
    const command = String(body.command ?? '');

    if (!this.#allowed(session, command)) {
      // Refused by NAME rather than silently: a client that asks for something
      // it was never offered is either out of date or malicious, and the two
      // are told apart by a human reading the log, not by the code.
      this.#log.warn(`device ${session.deviceId} asked for ${command}, which it was not offered`);
      return encodeJsonFrame(CONTROL.result as never, {
        seq,
        ok: false,
        error: { code: 'not-offered', message: `this device was not offered ${command}` },
      });
    }

    try {
      const value = await this.#options.host.invoke(session.deviceId, command, body.args);
      // Every command id the answer offered becomes runnable for this device —
      // which is what makes `views.children` the thing that widens the boundary,
      // and only for the rows it actually returned.
      this.#remember(session, value);
      return encodeJsonFrame(CONTROL.result as never, { seq, ok: true, value });
    } catch (error) {
      return encodeJsonFrame(CONTROL.result as never, {
        seq,
        ok: false,
        error: { code: 'handler-failed', message: String(error) },
      });
    }
  }

  /** A view's rows changed. The client re-asks; nothing is pushed but the hint. */
  changed(viewType: string): Uint8Array {
    return encodeJsonFrame(CONTROL.changed as never, { viewType });
  }

  #allowed(session: Session, command: string): boolean {
    return this.#discovery.has(command) || session.offered.has(command);
  }

  /**
   * Walks an answer for command ids and offers them.
   *
   * Structural rather than typed against `TreeItem`, because what comes back is
   * an extension's, has crossed a port, and `ok` says the call succeeded rather
   * than that the value has a shape. A cast here would be the "confident lie"
   * the agent relay was corrected for.
   */
  #remember(session: Session, value: unknown): void {
    const visit = (node: unknown, depth: number): void => {
      if (depth > 6 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry, depth + 1);
        return;
      }
      const record = node as Record<string, unknown>;
      const command = record['command'];
      if (typeof command === 'object' && command !== null) {
        const id = (command as { id?: unknown }).id;
        if (typeof id === 'string') session.offered.add(id);
      }
      // A row's context menu is as much an offer as its click is.
      const actions = record['actions'];
      if (Array.isArray(actions)) {
        for (const action of actions) {
          const id = (action as { id?: unknown } | null)?.id;
          if (typeof id === 'string') session.offered.add(id);
        }
      }
      for (const entry of Object.values(record)) visit(entry, depth + 1);
    };
    visit(value, 0);
  }
}

/**
 * The glue between `RemoteServer` and a `ControlChannel`: a `SessionSink` that
 * decodes each admitted connection's frames and writes the answers back.
 *
 * It lives HERE rather than in the app so that the loopback E2E exercises the
 * real thing. A copy in the test would prove the copy — and the two would agree
 * right up until one of them was changed, which is the failure mode this whole
 * package is arranged to avoid.
 */
export function controlSink(
  control: ControlChannel,
  log: CategoryLogger,
): {
  accept(connection: { write(b: Uint8Array): void; close(): void }): number;
  feed(id: number, bytes: Uint8Array): void;
  disconnect(id: number): void;
} {
  const wires = new Map<number, { decoder: FrameDecoder; write: (bytes: Uint8Array) => void }>();
  // Ours to mint, like every other sink's — a caller's id would collide the
  // moment a second transport used one. See `SessionSink.accept`.
  let nextId = 1;

  async function pump(id: number, bytes: Uint8Array): Promise<void> {
    const wire = wires.get(id);
    if (wire === undefined) return;
    const { frames, error } = wire.decoder.feed(bytes);
    for (const frame of frames) {
      const reply = await control.handle(id, frame);
      if (reply !== undefined) wire.write(reply);
    }
    if (error) log.error(`remote ${id} sent an unusable frame: ${error.message}`);
  }

  return {
    accept: (connection) => {
      const id = nextId;
      nextId += 1;
      wires.set(id, { decoder: new FrameDecoder(), write: connection.write });
      control.open(id, `device-${id}`);
      return id;
    },
    feed: (id, bytes) => void pump(id, bytes),
    disconnect: (id) => {
      wires.delete(id);
      control.close(id);
    },
  };
}
