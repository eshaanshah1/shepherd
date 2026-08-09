import { networkInterfaces } from 'node:os';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { err, ok, type Disposable, type Result } from '@shepherd/sdk';
import type { Identity } from './identity.ts';

/**
 * How a remote client reaches this Mac.
 *
 * The seam exists so that **LAN and tailnet are extensions**, which is the
 * decision this whole milestone is shaped around: core ships the protocol, the
 * pairing and the TLS termination, and something else decides which interface to
 * bind and how a device discovers it. v1 learned this the hard way — its LAN
 * listener had to bridge a terminated TLS connection into a server that was
 * hard-wired to the tailnet, through a `socketpair`, because there was no seam
 * to implement instead.
 *
 * Core ships **loopback only**. That is not a placeholder: it is what the E2E
 * runs on, so the interface has a real consumer without core shipping a
 * discovery stack it does not own.
 */

/** One accepted, TLS-terminated client. Framing is the protocol's job, not this. */
export interface RemoteConnection {
  /** Unique per connection, for logging and per-connection state (viewports). */
  readonly id: number;
  /** The peer's certificate DER, when it presented one. Absent for a one-way TLS client. */
  readonly peerCertificateDer?: Uint8Array;
  /** Where it came from, for the approval sheet — "a device on 192.168.1.4". */
  readonly remoteAddress: string;
  write(bytes: Uint8Array): void;
  close(): void;
  onData(fn: (bytes: Uint8Array) => void): void;
  onClose(fn: () => void): void;
}

export interface Listening extends Disposable {
  /** The port actually bound. `0` asks the OS, so this is the only honest source. */
  readonly port: number;
  readonly address: string;
}

export interface Endpoint {
  /** For logs and for the pairing payload a QR carries. */
  readonly kind: string;
  listen(onConnection: (connection: RemoteConnection) => void): Promise<Result<Listening, string>>;
}

export interface LoopbackOptions {
  readonly identity: Identity;
  /** `0` asks the OS for a free one, which is what a test wants. */
  readonly port?: number;
}

/**
 * TLS over `127.0.0.1`.
 *
 * Deliberately not `0.0.0.0`. v1's rule was "bind the tailscale interface, never
 * a wildcard, and refuse to serve rather than fall back to a public bind" — and
 * the same discipline applies here for a smaller reason: a loopback endpoint
 * that quietly listened on every interface would be a LAN server nobody decided
 * to run.
 */
export function loopbackEndpoint(options: LoopbackOptions): Endpoint {
  return tcpEndpoint({ ...options, kind: 'loopback', bindAddress: LOOPBACK });
}

/**
 * TLS over this Mac's address on the local network — `remote-wifi`.
 *
 * The second implementation of the seam, and the reason the seam exists: the
 * protocol, the pairing and the TLS termination are unchanged, and all this
 * decides is which interface to bind. v1 could not express that — its LAN
 * listener terminated TLS itself and bridged the raw fd into a server hard-wired
 * to the tailnet, through a `socketpair`, because there was nothing to implement.
 *
 * **A named interface, never `0.0.0.0`.** v1's rule, kept: a wildcard bind is a
 * server on every network this machine happens to be attached to, decided by
 * nobody. If no local address can be found, this refuses to listen rather than
 * falling back to one — a fallback here is the failure mode the rule exists to
 * prevent.
 */
export function wifiEndpoint(options: WifiOptions): Endpoint {
  const address = options.bindAddress ?? localAddress();
  if (address === undefined) {
    return {
      kind: 'wifi',
      listen: async () =>
        err('no local network address — this Mac is not on a network it can serve over'),
    };
  }
  return tcpEndpoint({ ...options, kind: 'wifi', bindAddress: address });
}

export interface WifiOptions {
  readonly identity: Identity;
  readonly port?: number;
  /** Override the auto-detected interface. Still never a wildcard. */
  readonly bindAddress?: string;
}

/**
 * This machine's IPv4 on the local network.
 *
 * Non-internal and IPv4: a `169.254.x` link-local or a loopback entry is not an
 * address a phone can reach, and handing one out produces a QR code that dials
 * nothing. Ordered so a real interface wins over a virtual one — Docker and VPN
 * bridges are up on plenty of machines and answer to nobody's phone.
 */
export function localAddress(interfaces = networkInterfaces()): string | undefined {
  const candidates: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      // `en*` on macOS is the physical/wifi family; anything else is a bridge,
      // a tunnel or a container network and goes to the back of the queue.
      if (name.startsWith('en')) candidates.unshift(entry.address);
      else candidates.push(entry.address);
    }
  }
  return candidates[0];
}

const LOOPBACK = '127.0.0.1';

interface TcpOptions {
  readonly identity: Identity;
  readonly port?: number;
  readonly kind: string;
  readonly bindAddress: string;
}

function tcpEndpoint(options: TcpOptions): Endpoint {
  return {
    kind: options.kind,
    listen: (onConnection) =>
      new Promise<Result<Listening, string>>((resolve) => {
        let nextId = 1;
        let server: Server;
        try {
          server = createServer(
            {
              key: options.identity.keyPem,
              cert: options.identity.certPem,
              /**
               * The client is not asked for a certificate.
               *
               * Its identity is the device id plus the secret we issued it, over
               * a channel whose SERVER end the client pinned — so a client
               * certificate would be a second identity to manage, revoke and
               * explain, proving nothing the secret does not already prove.
               */
              requestCert: false,
            },
            (socket: TLSSocket) => {
              const id = nextId;
              nextId += 1;
              const peer = socket.getPeerCertificate();
              const der = peer as unknown as { raw?: Buffer };
              onConnection({
                id,
                ...(der.raw === undefined ? {} : { peerCertificateDer: new Uint8Array(der.raw) }),
                remoteAddress: socket.remoteAddress ?? 'unknown',
                write: (bytes) => {
                  socket.write(bytes);
                },
                /**
                 * `end`, not `destroy` — and this is a measured distinction.
                 *
                 * A refusal is WRITTEN and then the connection is closed, and
                 * `destroy()` discards whatever is still buffered. The client
                 * then sees a socket that simply vanished, which is
                 * indistinguishable from a network fault and is exactly the
                 * silent drop that cost v1 a session of tcpdump. `end()` sends
                 * a FIN after the buffer flushes, so "wrong pairing code"
                 * actually arrives.
                 *
                 * The timer is the backstop for a peer that never reads: an
                 * unacked FIN must not hold the connection open forever.
                 */
                close: () => {
                  socket.end();
                  const forced = setTimeout(() => socket.destroy(), 1000);
                  forced.unref?.();
                },
                onData: (fn) =>
                  socket.on('data', (chunk: Buffer) => {
                    fn(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                  }),
                onClose: (fn) => socket.on('close', () => fn()),
              });
              // A client that errors must not take the listener with it: a
              // half-open connection is the normal way a phone leaves.
              socket.on('error', () => socket.destroy());
            },
          );
        } catch (error) {
          resolve(err(`could not create the ${options.kind} endpoint: ${String(error)}`));
          return;
        }

        server.once('error', (error) =>
          resolve(err(`${options.kind} endpoint failed to bind: ${String(error)}`)),
        );
        server.listen(options.port ?? 0, options.bindAddress, () => {
          const bound = server.address();
          if (bound === null || typeof bound === 'string') {
            resolve(err(`the ${options.kind} endpoint bound to something that is not a TCP address`));
            return;
          }
          resolve(
            ok({
              port: bound.port,
              address: bound.address,
              dispose: () => server.close(),
            }),
          );
        });
      }),
  };
}
