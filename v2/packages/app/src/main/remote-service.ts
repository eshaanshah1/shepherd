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
  joinNet as joinAnotherNet,
  loadOrMintIdentity,
  memberClient,
  pinOf,
  type Endpoint,
  type Identity,
  type JoinRequest,
  type JoinRequestHandler,
  memberSessionSocket,
  selfAdvertisement,
  type MemberClient,
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
  /**
   * A member said one of its views changed, and this Mac is showing it.
   *
   * The notice already travels — the control channel has always sent it to a
   * connected client, which is how the phone stays live. What was missing was
   * anybody listening on this side. Without it a task finishing on the other Mac
   * would sit stale in this sidebar until something else happened to refresh it,
   * which is precisely the "why is this list wrong" that makes people stop
   * trusting a list.
   */
  readonly onMemberViewChanged?: (memberId: string, type: string) => void;
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
  const { support, registry, devices, log, onMemberViewChanged } = options;

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
    // A FACT about how this device got in, not a capability: the root key that
    // signed it was destroyed the moment it did (see `foundNet`).
    founded: membership.chain[membership.chain.length - 1]?.memberId === membership.memberId,
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
  /** memberId -> a live connection to that member, for driving it from here. */
  const members = new Map<string, MemberClient>();
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

    async joinNet(uri) {
      /**
       * The certificate pin THIS Mac serves on, carried into the credential the
       * other Mac issues — so every other member can bind this member's
       * credential to the certificate it presents. Empty until we have served
       * once, which is honest rather than a placeholder: a Mac nobody can reach
       * has no certificate to name.
       */
      const joined = await joinAnotherNet({
        uri,
        deviceId,
        deviceName,
        certPin: identityPin,
        now: () => Date.now(),
        /**
         * Where the net can reach this Mac afterwards.
         *
         * Without it this Mac is admitted and then unreachable — listed in
         * everyone's roster with no address, so the phone that just joined can
         * never dial it. The ports only; the other end supplies the address.
         */
        /*
         * …unless what we serve on is loopback, in which case NOTHING is
         * advertised (`selfAdvertisement`). Joining a net while serving on
         * 127.0.0.1 used to write an entry on every other member that named a
         * port only this machine can reach — healthy in every field and
         * undiallable. Being absent from their address book is the honest state:
         * this Mac is a client until it serves somewhere reachable.
         */
        ...(() => {
          const advertise = selfAdvertisement(
            reachable,
            readPort(join(support, 'remote-data-port')),
          );
          return advertise === undefined ? {} : { advertise };
        })(),
        // A Mac that is already in this net presents its membership instead of
        // a code, which is how it is readmitted with no ceremony at all.
        ...(() => {
          const held = store.memberships().find((m) => uri.includes(m.netId));
          return held === undefined ? {} : { membership: held };
        })(),
      });
      if (!joined.ok) throw new Error(joined.error);
      store.putMembership(joined.value);
      store.setActiveNet(joined.value.netId);
      log.info(`joined net ${joined.value.netName} as ${joined.value.memberId}`);
      return summarize(joined.value);
    },

    /**
     * The DATA path to a member: a socket onto its session protocol.
     *
     * Not cached, unlike `invokeAt`'s control client — the caller
     * (`SessionRouter`) keeps one `SessionClient` per member and reconnects
     * through this on its own schedule, so caching a socket here would be a
     * second lifetime for the same connection and the two would disagree about
     * whether it is up.
     *
     * The host comes off the roster's control address and the port off
     * `dataPort`, because they are different listeners in different processes —
     * the app serves control, `shepherdd` serves the ptys.
     */
    async sessionSocket(memberId: string) {
      const membership = store.active();
      if (membership === undefined) throw new Error('this Mac is in no net');

      const entry = store.roster(membership.netId).find((row) => row.memberId === memberId);
      const address = entry?.addrs[0];
      if (entry === undefined || address === undefined) {
        throw new Error(
          entry === undefined
            ? `${memberId} is not a member of ${membership.netName}`
            : `${entry.name} is in this net but has no address to reach it at`,
        );
      }
      if (entry.dataPort === undefined) {
        /**
         * In the net, reachable, and serving no terminals — which is a real
         * state and not a fault. A member whose daemon has not come up, or that
         * has no data path at all, advertises no `dataPort`; a phone in the
         * roster is legitimately the same. Named, because "nothing happened when
         * I clicked" has to be traceable to something.
         */
        throw new Error(`${entry.name} is not serving terminals`);
      }
      const host = address.slice(0, address.lastIndexOf(':'));
      return await memberSessionSocket({
        membership,
        host,
        port: entry.dataPort,
        deviceId,
        deviceName,
        now: () => Date.now(),
        // Nothing at all when what we serve on is loopback: see
        // `selfAdvertisement`. A healthy-looking roster entry nobody can dial is
        // worse than no entry.
        ...(() => {
          const advertise = selfAdvertisement(reachable);
          return advertise === undefined ? {} : { advertise };
        })(),
        log: (message: string) => log.info(`member ${entry.name}: ${message}`),
      });
    },

    async invokeAt(memberId: string, command: string, args: unknown) {
      const membership = store.active();
      if (membership === undefined) throw new Error('this Mac is in no net');

      const entry = store.roster(membership.netId).find((row) => row.memberId === memberId);
      const address = entry?.addrs[0];
      if (entry === undefined || address === undefined) {
        // Named rather than shrugged at: "not in the net" and "in the net but
        // nowhere to reach" call for different actions, and a phone that serves
        // nothing is legitimately the second.
        throw new Error(
          entry === undefined
            ? `${memberId} is not a member of ${membership.netName}`
            : `${entry.name} is in this net but has no address to reach it at`,
        );
      }
      const [host, port] = [address.slice(0, address.lastIndexOf(':')), address.slice(address.lastIndexOf(':') + 1)];

      /**
       * One live client per member, kept.
       *
       * A connection per call would pay the TLS handshake and the whole
       * membership check on every keystroke's worth of UI, and would drop the
       * `changed` notice that tells this Mac a remote view's rows moved.
       */
      let client = members.get(memberId);
      if (client === undefined) {
        client = memberClient({
          membership,
          host,
          port: Number.parseInt(port, 10),
          deviceId,
          deviceName,
          now: () => Date.now(),
          // See `selfAdvertisement`: a Mac serving on loopback advertises
          // nothing rather than an address that resolves, over there, to them.
          ...(() => {
            const advertise = selfAdvertisement(reachable);
            return advertise === undefined ? {} : { advertise };
          })(),
          log: (message: string) => log.info(`member ${entry.name}: ${message}`),
        });
        client.onChanged((type) => onMemberViewChanged?.(memberId, type));
        members.set(memberId, client);
      }
      return client.invoke(command, args);
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
      for (const client of members.values()) client.stop();
      members.clear();
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
