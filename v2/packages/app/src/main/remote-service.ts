import { join } from 'node:path';
import { FrameDecoder, type CommandRegistry } from '@shepherd/core';
import { runExec } from '@shepherd/platform-darwin';
import { s as schema, type CategoryLogger, type Disposable, type KV } from '@shepherd/sdk';
import {
  ControlChannel,
  RemoteServer,
  loadOrMintIdentity,
  pinOf,
  type Endpoint,
  type Identity,
  type PairedDevice,
  type PairingPayload,
  type PairingRequest,
  type PairingRequestHandler,
  type RemoteAPI,
} from '@shepherd/remote';

/**
 * Remote, wired into the app: `RemoteAPI` with real parts behind it.
 *
 * Everything domain-shaped is somebody else's. The endpoint is supplied (core
 * ships loopback; `remote-lan` and `remote-tailscale` supply theirs), the
 * approval is a handler the UI registers, and what a device may actually DO is
 * the command registry's decision. This file wires; it does not decide.
 *
 * The one decision it makes is the **default refusal**: with no approval handler
 * registered, a pairing request is DENIED. An app that has not yet drawn its
 * pairing sheet must not be an app that lets a stranger in, and "fail open while
 * the UI loads" is the shape that ships as a hole nobody notices.
 */

export interface RemoteServiceOptions {
  readonly support: string;
  readonly registry: CommandRegistry;
  /** Where paired devices live. Shared with the daemon — see `store` below. */
  readonly devices: KV;
  readonly log: CategoryLogger;
}

const DEVICES_KEY = 'paired';

/**
 * The persisted shape of a paired device.
 *
 * Declared rather than cast: this comes off disk, an older build may have
 * written it, and `KV.get` takes a schema for exactly that reason. A cast would
 * turn a half-written record into a device that pairs and then fails somewhere
 * far from here.
 */
const DEVICE_SCHEMA = schema.array(
  schema.object({
    id: schema.string(),
    name: schema.string(),
    secret: schema.string(),
    pin: schema.string(),
    pairedAt: schema.number(),
    lastSeenAt: schema.number(),
  }),
);
const PROTOCOL_VERSION = 3;

export function createRemoteService(options: RemoteServiceOptions): RemoteAPI & Disposable {
  const { support, registry, devices, log } = options;

  /**
   * Paired devices, on disk and shared with the daemon.
   *
   * A device pairs ONCE and connects twice — control here, data there — and the
   * second connection presents the secret the first was issued. Only this
   * process can CREATE a pairing, because only this process can show an
   * approval: the daemon never shows a code, so an unknown device is refused
   * there by the pairing model as it already stands. A headless process cannot
   * admit a stranger, which is a property rather than a limitation.
   */
  const store = {
    all: (): readonly PairedDevice[] => devices.get(DEVICES_KEY, DEVICE_SCHEMA) ?? [],
    put: (device: PairedDevice): void => {
      devices.set(DEVICES_KEY, [
        ...store.all().filter((candidate) => candidate.id !== device.id),
        device,
      ]);
    },
    remove: (id: string): void => {
      devices.set(
        DEVICES_KEY,
        store.all().filter((candidate) => candidate.id !== id),
      );
    },
  };

  const control = new ControlChannel({
    host: {
      /**
       * A device's invocation, attributed as a DEVICE.
       *
       * Straight into the one verb table, with the envelope saying who asked.
       * Authorization runs in the dispatcher before any handler (§4.3), so this
       * transport does not get to decide — which is exactly the read-side-only
       * hole the architecture review found in v1.
       */
      invoke: async (deviceId, command, args) => {
        const answer = await registry.invoke(command, args, { kind: 'device', deviceId });
        if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
        return answer.value;
      },
    },
    log,
  });

  /**
   * The per-connection state the control channel needs and `RemoteServer` does
   * not: a decoder, and somewhere to write the answer back.
   *
   * `RemoteServer` hands over an admitted connection and stops caring what is
   * said on it — which is what lets the SAME server front the session protocol
   * in the daemon and this one here.
   */
  const wires = new Map<number, { decoder: FrameDecoder; write: (bytes: Uint8Array) => void }>();

  let approve: PairingRequestHandler | undefined;
  let server: RemoteServer | undefined;
  const listeners: Disposable[] = [];
  let identityPin = '';
  /**
   * Where we are actually reachable, as the ENDPOINT reported it.
   *
   * Not a constant. It was `127.0.0.1` for one commit, which is right for
   * loopback and wrong the moment a LAN endpoint binds — and a payload naming
   * the wrong address is a QR that cannot work, with nothing saying why.
   */
  let reachable: { host: string; port: number } | undefined;

  const api: RemoteAPI & Disposable = {
    async serve(factory: (identity: Identity) => Endpoint): Promise<Disposable> {
      const identity = await loadOrMintIdentity({
        dir: join(support, 'remote-identity'),
        // Through the platform's ProcessAPI, never `child_process` from here —
        // the rule every other caller keeps, and the reason it is injectable.
        mint: async (args) => {
          // A generous deadline: minting an RSA-2048 key is ~70ms measured, but
          // an entropy-starved machine is slow rather than broken.
          const result = await runExec(['/usr/bin/openssl', ...args], {
            cwd: support,
            timeoutMs: 30_000,
          });
          return result.ok && result.code === 0
            ? { ok: true, value: undefined }
            : { ok: false, error: result.stderr || `openssl exited ${result.code}` };
        },
      });
      if (!identity.ok) {
        // A branch that ends in "and then nothing happens" says why: with no
        // listener, a phone's attempt is indistinguishable from a firewall
        // block, which cost v1 a session of tcpdump.
        log.error(`remote cannot serve without an identity: ${identity.error}`);
        return { dispose: () => undefined };
      }
      identityPin = pinOf(identity.value.certPem).pin;

      server ??= new RemoteServer({
        endpoint: factory(identity.value),
        identity: identity.value,
        devices: store,
        sessions: {
          accept: (connection) => {
            wires.set(connection.id, { decoder: new FrameDecoder(), write: connection.write });
            // The device id is settled by the handshake; the channel only needs
            // it for attribution, and `RemoteServer` has already checked it.
            control.open(connection.id, `device-${connection.id}`);
          },
          feed: (id, bytes) => void pump(id, bytes),
          disconnect: (id) => {
            wires.delete(id);
            control.close(id);
          },
        },
        approve: async (request) => {
          const handler = approve;
          if (handler === undefined) {
            log.warn(`refusing ${request.device.name}: nothing is registered to approve pairings`);
            return false;
          }
          const asked: PairingRequest = {
            deviceId: request.device.id,
            deviceName: request.device.name,
            from: request.from,
            ...(request.sas === undefined ? {} : { sas: request.sas }),
          };
          return handler(asked);
        },
        log,
        newSecret: () => crypto.randomUUID(),
        // Zero-padded: a "code" with five digits is a code somebody mistypes.
        newCode: () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
        now: () => Date.now(),
      });

      const started = await server.start();
      if (!started.ok) return { dispose: () => undefined };
      reachable = { host: started.value.address, port: started.value.port };
      listeners.push(started.value);
      return started.value;
    },

    showPairingCode: () => server?.showCode() ?? '',
    activeCode: () => server?.activeCode,

    pairingPayload(): PairingPayload | undefined {
      if (reachable === undefined || identityPin === '') return undefined;
      const code = server?.activeCode;
      return {
        host: reachable.host,
        port: reachable.port,
        pin: identityPin,
        ...(code === undefined ? {} : { code }),
        protocolVersion: PROTOCOL_VERSION,
      };
    },

    devices: () => store.all(),
    revoke: (deviceId) => server?.revoke(deviceId),

    onPairingRequest(handler) {
      if (approve !== undefined) {
        // Two approval surfaces racing to answer one request is a design where a
        // device gets in because the slower one was going to say no.
        log.warn('a second pairing-approval handler was refused; one is already registered');
        return { dispose: () => undefined };
      }
      approve = handler;
      return {
        dispose: () => {
          approve = undefined;
        },
      };
    },

    dispose() {
      server?.stop();
      for (const listener of listeners.splice(0)) listener.dispose();
      wires.clear();
    },
  };

  /** Decode this connection's frames and answer the ones the channel owns. */
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

  return api;
}
