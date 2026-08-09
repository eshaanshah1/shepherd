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
  return {
    kind: 'loopback',
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
                close: () => socket.destroy(),
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
          resolve(err(`could not create the loopback endpoint: ${String(error)}`));
          return;
        }

        server.once('error', (error) => resolve(err(`loopback endpoint failed to bind: ${String(error)}`)));
        server.listen(options.port ?? 0, '127.0.0.1', () => {
          const bound = server.address();
          if (bound === null || typeof bound === 'string') {
            resolve(err('the loopback endpoint bound to something that is not a TCP address'));
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
