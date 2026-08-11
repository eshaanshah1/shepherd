import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FrameDecoder, type CommandRegistry } from '@shepherd/core';
import { runExec, systemHostName } from '@shepherd/platform-darwin';
import {
  PERMISSIONS,
  s,
  type CategoryLogger,
  type Disposable,
  type KV,
  type Permission,
} from '@shepherd/sdk';
import {
  ControlChannel,
  RemoteServer,
  REMOTE_PROTOCOL_VERSION,
  foundNet,
  kvNetStore,
  loadOrMintIdentity,
  pinOf,
  type Endpoint,
  type Identity,
  type JoinRequest,
  type JoinRequestHandler,
  type Membership,
  type NetSummary,
  type PairingPayload,
  type RemoteAPI,
  type RemoteServerOptions,
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

/**
 * What a paired device may ask the kernel to do.
 *
 * The same set the local CLI holds, and the reasoning is `ingress.ts`'s one step
 * along: reaching the local socket IS the authorization there, and being
 * APPROVED BY A HUMAN AT THIS MAC is the authorization here. A device did not
 * arrive by accident — somebody read its name and pressed Allow.
 *
 * The finer gate is not this list, it is the control channel: a device may
 * invoke only the verbs declared on rows it was actually sent. So this answers
 * "may this principal use the kernel at all", and the row boundary answers
 * "which verbs" — two questions, two places, neither pretending to be the other.
 *
 * Per-device entitlements (this phone may read, that Mac may also close panes)
 * are the obvious next step and are deliberately not invented here: there is one
 * device kind today, and a permission model shaped around it would be shaped
 * around one caller.
 */
export const PAIRED_DEVICE_PERMISSIONS: readonly Permission[] = PERMISSIONS;

export interface RemoteServiceOptions {
  readonly support: string;
  readonly registry: CommandRegistry;
  /**
   * Where this device's net memberships live — a namespace of THE store, opened
   * at a path the daemon can open too. One record, two readers (ADR 0021).
   */
  readonly devices: KV;
  readonly log: CategoryLogger;
}

/**
 * This Mac's id inside every net it joins, minted once and kept.
 *
 * Kept is the load-bearing half: it is what a credential names and what a
 * revocation names, so a Mac that minted a fresh one on each launch would arrive
 * at every other member as a stranger — and the tombstone for the device you
 * revoked would name an id that no longer exists.
 */
const DEVICE_ID = 'device-id';

export function createRemoteService(options: RemoteServiceOptions): RemoteAPI & Disposable {
  const { support, registry, devices, log } = options;

  const deviceId =
    devices.get(DEVICE_ID, s.string()) ??
    (() => {
      const minted = crypto.randomUUID();
      devices.set(DEVICE_ID, minted);
      return minted;
    })();
  const deviceName = systemHostName();

  /**
   * The nets this Mac is in, on disk and shared with the daemon.
   *
   * A device joins ONCE and connects twice — control here, data there — and both
   * connections present the same credential chain. Only this process can ADMIT a
   * new member, because only this process can show an approval: the daemon never
   * shows a code, so a device with no membership is refused there by the join
   * model as it already stands. A headless process cannot admit a stranger,
   * which is a property rather than a limitation.
   */
  const store = kvNetStore(devices);

  const summarize = (membership: Membership): NetSummary => ({
    netId: membership.netId,
    name: membership.netName,
    memberId: membership.memberId,
    founded: membership.rootPrivateKey !== undefined,
  });

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
  let nextWireId = 1;

  /** connectionId -> the device it turned out to be. */
  const admitted = new Map<number, string>();
  let approve: JoinRequestHandler | undefined;
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
    async serve(factory: (identity: Identity, port?: number) => Endpoint): Promise<Disposable> {
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

      /**
       * The port this Mac served on last time, re-used.
       *
       * A device stores the port it paired with, so an OS-chosen one moves on
       * every launch and leaves a paired phone dialling an address that now
       * belongs to nobody — it says "connecting" forever, which is exactly what
       * the first device run did. The daemon does not have this problem because
       * it outlives the app; the control port has to be given the property
       * deliberately.
       *
       * A remembered port that is taken falls back to a fresh one rather than
       * refusing to serve: being reachable at a new address beats not serving.
       */
      const remembered = readPort(join(support, 'remote-control-port'));

      const serverOptions: Omit<RemoteServerOptions, 'endpoint'> = {
        identity: identity.value,
        net: store,
        sessions: {
          accept: (connection) => {
            // Ours to mint — a caller's id belongs to a different table. See
            // `SessionSink.accept`, where sharing one cost the app every reply.
            const id = nextWireId;
            nextWireId += 1;
            wires.set(id, { decoder: new FrameDecoder(), write: connection.write });
            // Opened with the REAL device id in `onAdmitted` below, which fires
            // immediately after with this same id. A placeholder here would be
            // a caller the grant set can never match.
            return id;
          },
          feed: (id, bytes) => void pump(id, bytes),
          disconnect: (id) => {
            wires.delete(id);
            admitted.delete(id);
            control.close(id);
          },
        },
        onAdmitted: (connectionId, member) => {
          admitted.set(connectionId, member.memberId);
          control.open(connectionId, member.memberId);
        },
        approve: async (request) => {
          const handler = approve;
          if (handler === undefined) {
            log.warn(`refusing ${request.candidate.name}: nothing is registered to approve joins`);
            return false;
          }
          const asked: JoinRequest = {
            deviceId: request.candidate.memberId,
            deviceName: request.candidate.name,
            from: request.from,
            ...(request.sas === undefined ? {} : { sas: request.sas }),
          };
          return handler(asked);
        },
        log,
        // Zero-padded: a "code" with five digits is a code somebody mistypes.
        newCode: () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
        now: () => Date.now(),
        // Read per connection, not captured: the daemon may have restarted onto
        // a different port since this Mac started.
        dataPort: () => readPort(join(support, 'remote-data-port')),
      };

      server ??= new RemoteServer({ ...serverOptions, endpoint: factory(identity.value, remembered) });
      let started = await server.start();
      if (!started.ok && remembered !== undefined) {
        log.warn(`port ${remembered} is taken — serving on a fresh one; paired devices must re-pair`);
        server = new RemoteServer({ ...serverOptions, endpoint: factory(identity.value) });
        started = await server.start();
      }
      if (!started.ok) return { dispose: () => undefined };
      reachable = { host: started.value.address, port: started.value.port };
      try {
        writeFileSync(join(support, 'remote-control-port'), String(started.value.port), 'utf8');
      } catch (error) {
        log.warn(`could not remember the control port: ${String(error)}`);
      }
      listeners.push(started.value);
      return started.value;
    },

    showPairingCode: () => server?.showCode() ?? '',
    activeCode: () => server?.activeCode,

    pairingPayload(): PairingPayload | undefined {
      if (reachable === undefined || identityPin === '') return undefined;
      const code = server?.activeCode;
      // Chosen by the OS in another process, so the file the daemon wrote is the
      // only honest source for it.
      let dataPort: number | undefined;
      try {
        const raw = readFileSync(join(support, 'remote-data-port'), 'utf8').trim();
        dataPort = Number.parseInt(raw, 10) || undefined;
      } catch {
        dataPort = undefined;
      }
      /**
       * No net, no payload. A device cannot be told how to join something this
       * Mac is not in, and handing back an address with no net would produce a
       * QR that dials, is refused, and explains nothing.
       */
      const net = store.active();
      if (net === undefined) return undefined;
      return {
        host: reachable.host,
        port: reachable.port,
        ...(dataPort === undefined ? {} : { dataPort }),
        pin: identityPin,
        ...(code === undefined ? {} : { code }),
        netId: net.netId,
        netName: net.netName,
        rootPublicKey: net.rootPublicKey,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
      };
    },

    nets: () => store.memberships().map(summarize),
    activeNet: () => {
      const active = store.active();
      return active === undefined ? undefined : summarize(active);
    },
    setActiveNet: (netId) => store.setActiveNet(netId),

    createNet(name) {
      const membership = foundNet({
        netName: name,
        memberId: deviceId,
        memberName: deviceName,
        // Empty until this Mac has an identity to bind to; it is filled on the
        // first `serve`, which is the only point at which this Mac has a
        // certificate for anyone to reach it by.
        certPin: identityPin,
        now: Date.now(),
      });
      store.putMembership(membership);
      log.info(`created net ${name} (${membership.netId.slice(0, 12)}…)`);
      return summarize(membership);
    },

    leaveNet: (netId) => store.removeMembership(netId),

    members: () => {
      const active = store.active();
      return active === undefined ? [] : store.roster(active.netId);
    },
    revoke: (memberId) => server?.revoke(memberId),

    onJoinRequest(handler) {
      if (approve !== undefined) {
        // Two approval surfaces racing to answer one request is a design where a
        // device gets in because the slower one was going to say no.
        log.warn('a second join-approval handler was refused; one is already registered');
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

/** A remembered port, or undefined when there is none to remember. */
function readPort(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
