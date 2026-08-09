import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import type { CategoryLogger } from '@shepherd/sdk';
import type { Endpoint, Listening, RemoteConnection } from './endpoint.ts';
import type { Identity } from './identity.ts';
import {
  freshCode,
  pairingDecision,
  spendAttempt,
  type Hello,
  type PairedDevice,
  type PairingCode,
} from './pairing.ts';

/**
 * The remote server: a GATE in front of the session protocol.
 *
 * It is deliberately not a second way to reach a session. A connection that gets
 * through the handshake is handed to the same `SessionServer` the Mac's renderer
 * talks to, as an ordinary `Connection` — so a phone speaks the identical
 * protocol, hits the identical fanout, and is handed the identical screen. That
 * is what makes "the phone is just another client for the same pty" a fact about
 * the architecture rather than a claim about it.
 *
 * v1 could not do this. Its remote path was a second implementation — a helper
 * that teed bytes, its own replay ring, its own attach semantics — and the three
 * copies drifted, which is what `applyRemoteCommand` beside `controlRoute` beside
 * `ShortcutActions` was (review §Bad-2).
 *
 * **Frame kinds are disjoint from the session protocol's on purpose** (128+ vs
 * 1–68). One decoder reads both, so a handshake frame arriving mid-stream, or a
 * session frame arriving before the handshake, is a typed refusal rather than a
 * misparse.
 */

export const REMOTE = {
  hello: 128,
  accepted: 129,
  rejected: 130,
  pendingApproval: 131,
} as const;

/** What the host decides about a device that wants in. */
export type Approval = (request: {
  readonly device: PairedDevice;
  readonly sas?: string;
  readonly from: string;
}) => Promise<boolean>;

/** Where paired devices live across restarts. */
export interface DeviceStore {
  all(): readonly PairedDevice[];
  put(device: PairedDevice): void;
  remove(deviceId: string): void;
}

/** What the remote server hands an accepted connection to. `SessionServer` fits. */
export interface SessionSink {
  accept(connection: { id: number; write(b: Uint8Array): void; close(): void }): void;
  feed(id: number, bytes: Uint8Array): void;
  disconnect(id: number): void;
}

export interface RemoteServerOptions {
  readonly endpoint: Endpoint;
  readonly identity: Identity;
  readonly devices: DeviceStore;
  readonly sessions: SessionSink;
  readonly approve: Approval;
  readonly log: CategoryLogger;
  /** Injected: randomness stays out of the model (see `pairing.ts`). */
  readonly newSecret: () => string;
  readonly newCode: () => string;
  readonly now: () => number;
}

interface ClientState {
  readonly connection: RemoteConnection;
  readonly decoder: FrameDecoder;
  /** True once the handshake succeeded and the session server owns the frames. */
  admitted: boolean;
  deviceId?: string;
}

export class RemoteServer {
  readonly #options: RemoteServerOptions;
  readonly #log: CategoryLogger;
  readonly #clients = new Map<number, ClientState>();
  #code: PairingCode | undefined;
  #listening: Listening | undefined;

  constructor(options: RemoteServerOptions) {
    this.#options = options;
    this.#log = options.log;
  }

  get port(): number | undefined {
    return this.#listening?.port;
  }

  /** The digits to show. Minting a new one invalidates whatever was showing. */
  showCode(): string {
    this.#code = freshCode(this.#options.newCode(), this.#options.now());
    return this.#code.digits;
  }

  get activeCode(): string | undefined {
    return this.#code?.digits;
  }

  async start(): Promise<ReturnType<Endpoint['listen']>> {
    const started = await this.#options.endpoint.listen((connection) => this.#accept(connection));
    if (started.ok) {
      this.#listening = started.value;
      this.#log.info(
        `remote is serving on ${this.#options.endpoint.kind} ${started.value.address}:${started.value.port}`,
      );
    } else {
      // A branch that ends in "and then nothing happens" says why: with no
      // listener, a phone's connection attempt is indistinguishable from a
      // firewall block, which cost v1 a session of tcpdump.
      this.#log.error(`remote did not start: ${started.error}`);
    }
    return started;
  }

  /**
   * Revoke a device and drop it NOW.
   *
   * Leaving its connections up until they happen to close would mean "revoked"
   * describes a future state rather than the current one — and the person doing
   * the revoking is usually doing it because the device is in somebody else's
   * hands.
   */
  revoke(deviceId: string): void {
    this.#options.devices.remove(deviceId);
    for (const [id, client] of [...this.#clients]) {
      if (client.deviceId !== deviceId) continue;
      client.connection.close();
      this.#drop(id);
    }
    this.#log.info(`revoked ${deviceId} and dropped its live connections`);
  }

  stop(): void {
    for (const [id, client] of [...this.#clients]) {
      client.connection.close();
      this.#drop(id);
    }
    this.#listening?.dispose();
    this.#listening = undefined;
  }

  // ------------------------------------------------------------------ internals

  #accept(connection: RemoteConnection): void {
    this.#clients.set(connection.id, {
      connection,
      decoder: new FrameDecoder(),
      admitted: false,
    });
    connection.onClose(() => this.#drop(connection.id));
    connection.onData((bytes) => this.#onData(connection.id, bytes));
    this.#log.info(`remote connection ${connection.id} from ${connection.remoteAddress}`);
  }

  #drop(id: number): void {
    const client = this.#clients.get(id);
    if (client === undefined) return;
    // The session server hears about it only if it was ever told about it —
    // and when it does, R1's rule applies: viewers go, sessions do not.
    if (client.admitted) this.#options.sessions.disconnect(id);
    this.#clients.delete(id);
  }

  #onData(id: number, bytes: Uint8Array): void {
    const client = this.#clients.get(id);
    if (client === undefined) return;

    // Admitted: the session protocol owns every byte from here. Fed straight
    // through rather than re-decoded, so there is exactly one decoder per
    // connection and no chance of the two disagreeing about a frame boundary.
    if (client.admitted) {
      this.#options.sessions.feed(id, bytes);
      return;
    }

    const { frames, error } = client.decoder.feed(bytes);
    for (const frame of frames) this.#handshake(client, frame);
    if (error) {
      this.#log.error(`remote ${id} sent an unusable frame (${error.code}): ${error.message}`);
      client.connection.close();
      this.#drop(id);
    }
  }

  #handshake(client: ClientState, frame: Frame): void {
    // Compared as a NUMBER: the remote kinds live above the session protocol's
    // range on purpose (128+ vs 1-68) and are deliberately not members of its
    // union, so one decoder reads both without either becoming the other's type.
    if ((frame.kind as number) !== REMOTE.hello) {
      // A session frame before the handshake is the shape an attacker's first
      // probe takes, and the shape a buggy client takes. Both get the same
      // answer, and neither reaches a pty.
      this.#reject(client, 'send hello before anything else');
      return;
    }

    const hello = frame.json as Hello;
    const decision = pairingDecision({
      hello,
      devices: this.#options.devices.all(),
      code: this.#code,
      now: this.#options.now(),
      newSecret: this.#options.newSecret(),
      certSha256: this.#options.identity.sha256,
    });

    if (decision.kind === 'reject') {
      if (decision.spendsAttempt && this.#code !== undefined) {
        this.#code = spendAttempt(this.#code);
      }
      this.#reject(client, decision.reason);
      return;
    }

    if (decision.kind === 'accept') {
      this.#admit(client, decision.device);
      return;
    }

    // Needs a human. The connection stays open and idle meanwhile — the client
    // is told so explicitly rather than being left to guess from silence.
    this.#send(client, REMOTE.pendingApproval, {});
    void this.#options
      .approve({
        device: decision.device,
        ...(decision.sas === undefined ? {} : { sas: decision.sas }),
        from: client.connection.remoteAddress,
      })
      .then((approved) => {
        if (!this.#clients.has(client.connection.id)) return; // gave up waiting
        if (!approved) {
          this.#reject(client, 'this Mac declined the pairing');
          return;
        }
        // The code is one device, once. Burning it on approval — not on the
        // attempt — means a denied pairing does not cost the next attempt.
        this.#code = undefined;
        this.#options.devices.put(decision.device);
        this.#admit(client, decision.device);
      })
      .catch((error: unknown) => {
        this.#log.error(`approval threw for ${decision.device.id}: ${String(error)}`);
        this.#reject(client, 'the approval could not be shown');
      });
  }

  #admit(client: ClientState, device: PairedDevice): void {
    client.admitted = true;
    client.deviceId = device.id;
    this.#options.devices.put({ ...device, lastSeenAt: this.#options.now() });

    // The secret goes back on EVERY admit, not only the first: it is what the
    // device presents next time, and a client that lost it would otherwise have
    // to be re-paired by hand.
    this.#send(client, REMOTE.accepted, { secret: device.secret, deviceId: device.id });

    // From here the connection IS a session connection. No translation layer,
    // no second protocol — that is the whole design.
    this.#options.sessions.accept({
      id: client.connection.id,
      write: (bytes) => client.connection.write(bytes),
      close: () => client.connection.close(),
    });
    this.#log.info(`remote ${client.connection.id} admitted as ${device.name} (${device.id})`);
  }

  #reject(client: ClientState, reason: string): void {
    this.#log.warn(`remote ${client.connection.id} refused: ${reason}`);
    this.#send(client, REMOTE.rejected, { reason });
    client.connection.close();
    this.#drop(client.connection.id);
  }

  #send(client: ClientState, kind: number, body: Record<string, unknown>): void {
    try {
      client.connection.write(encodeJsonFrame(kind as never, body));
    } catch (error) {
      this.#log.warn(`writing to remote ${client.connection.id} threw: ${String(error)}`);
    }
  }
}
