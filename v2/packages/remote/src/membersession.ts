import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import {
  REMOTE_KINDS,
  certPinOf,
  checkMemberAccept,
  memberHelloFrame,
  splitFrame,
} from './memberhandshake.ts';
import type { Membership } from './netstore.ts';

/**
 * A socket onto another member's SESSION protocol.
 *
 * This is the client half the Mac was missing. The daemon has served the session
 * protocol to members since D4 — `RemoteServer` is a gate in front of the same
 * `SessionServer` the local renderer talks to, and the phone speaks it already —
 * but nothing on a Mac dialled another member's **data** path. `remote.at` is the
 * control channel only.
 *
 * **What rides the socket is the difference, and the only difference.** The
 * handshake is the identical one `memberclient.ts` performs (shared, in
 * `memberhandshake.ts`), and afterwards this is not a remote protocol at all: it
 * is the session protocol, spoken to a session server, by the same
 * `SessionClient` the app points at its own daemon. So attach, per-viewer
 * snapshots, viewport arbitration, reconnect and re-attach-every-viewer all come
 * for free and cannot drift from the local path — there is no second
 * implementation of any of them.
 *
 * Deliberately NOT a `SessionClient` itself: it resolves to something a
 * `SessionClient` can be built on, so the layering stays "one client, several
 * transports" rather than "one client per transport".
 */

/** Exactly what `SessionClient`'s `ClientSocket` needs. Structural, not imported. */
export interface MemberSocket {
  write(bytes: Uint8Array): void;
  destroy(): void;
  onData(fn: (bytes: Uint8Array) => void): void;
  onClose(fn: () => void): void;
  onError(fn: (error: unknown) => void): void;
}

export interface MemberSessionOptions {
  /** This device's membership of the net the target belongs to. */
  readonly membership: Membership;
  readonly host: string;
  /** The member's DATA port — `RosterEntry.dataPort`, never its control port. */
  readonly port: number;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly now: () => number;
  /** What this Mac serves on, so the member can list it in its own roster. */
  readonly advertise?: { readonly port: number; readonly dataPort?: number };
  /**
   * How long to wait for the member to admit us.
   *
   * A machine that is asleep, or awake on another network with a stale roster
   * address, accepts a TCP connection nowhere and answers nothing — so without a
   * deadline the promise simply never settles and the pane waiting on it never
   * says why.
   */
  readonly handshakeMs?: number;
  readonly log?: (message: string) => void;
}

export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Dial a member and come back with a socket that is already past the door.
 *
 * Rejects with the member's own reason for refusing, or with why it could not be
 * reached — the two call for different actions and a caller that cannot tell them
 * apart cannot report either honestly.
 */
export async function memberSessionSocket(options: MemberSessionOptions): Promise<MemberSocket> {
  const log = options.log ?? (() => undefined);
  const nonce = randomBytes(16).toString('hex');

  return await new Promise<MemberSocket>((resolve, reject) => {
    let observedPin = '';
    let admitted = false;
    let settled = false;
    /**
     * Bytes the handshake has not consumed. Handed on at the moment of admission.
     *
     * `ArrayBufferLike`, not `ArrayBuffer`, for the reason `FrameDecoder`'s own
     * buffer is: a socket chunk can be a view over a pooled buffer.
     */
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    /** Set by the socket's owner once it is handed over. */
    let onData: ((bytes: Uint8Array) => void) | undefined;
    let onClose: (() => void) | undefined;
    let onError: ((error: unknown) => void) | undefined;

    const deadline = setTimeout(() => {
      fail(`${options.host}:${options.port} did not answer the handshake`);
    }, options.handshakeMs ?? HANDSHAKE_TIMEOUT_MS);
    deadline.unref?.();

    const fail = (reason: string): void => {
      clearTimeout(deadline);
      if (settled) {
        // Already handed over: the failure belongs to the socket's owner, which
        // has a reconnect policy of its own. Rejecting a settled promise is a
        // silent no-op, and this is exactly where a dropped member connection
        // would otherwise go unreported.
        onError?.(new Error(reason));
        return;
      }
      settled = true;
      tls.destroy();
      reject(new Error(reason));
    };

    const tls: TLSSocket = connect(
      { host: options.host, port: options.port, rejectUnauthorized: false },
      () => {
        const peer = tls.getPeerX509Certificate();
        if (peer === undefined) {
          fail('that member presented no certificate');
          return;
        }
        // Learned, not trusted: the accept must produce a credential that names
        // this very certificate, or `checkMemberAccept` refuses.
        observedPin = certPinOf(peer.raw);
        tls.write(
          memberHelloFrame({
            membership: options.membership,
            deviceId: options.deviceId,
            deviceName: options.deviceName,
            observedPin,
            nonce,
            now: options.now(),
            ...(options.advertise === undefined ? {} : { advertise: options.advertise }),
          }),
        );
      },
    );

    tls.on('data', (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk);

      // Past the door: every byte is the session protocol's, forwarded whole.
      if (admitted) {
        onData?.(bytes);
        return;
      }

      buffer = concat(buffer, bytes);

      // ONE frame at a time, keeping the remainder — the chunk that carries
      // `accepted` can carry session bytes behind it, and those belong to the
      // reader we are about to hand this socket to.
      for (;;) {
        const split = splitFrame(buffer);
        if (split.kind === 'incomplete') return;
        if (split.kind === 'error') {
          fail(`that member sent an unusable frame (${split.message})`);
          return;
        }
        buffer = split.rest;
        const kind = split.frame.kind as number;

        if (kind === REMOTE_KINDS.accepted) {
          const why = checkMemberAccept(split.frame, options.membership, nonce, observedPin);
          if (why !== undefined) {
            fail(why);
            return;
          }
          clearTimeout(deadline);
          admitted = true;
          settled = true;
          log(`attached to the session path on ${options.host}:${options.port}`);
          resolve({
            write: (out) => tls.write(out),
            destroy: () => tls.destroy(),
            onData: (fn) => {
              onData = fn;
            },
            onClose: (fn) => {
              onClose = fn;
            },
            onError: (fn) => {
              onError = fn;
            },
          });
          /**
           * Whatever arrived behind `accepted`, delivered on the next tick.
           *
           * Not synchronously: the caller has not had a chance to register
           * `onData` yet — it receives the socket from `await`, which is a
           * microtask away — so handing the bytes over now would drop them. This
           * is the whole reason the remainder is tracked at all.
           */
          if (buffer.length > 0) {
            const pending = buffer;
            buffer = new Uint8Array(0);
            queueMicrotask(() => onData?.(pending));
          }
          return;
        }

        if (kind === REMOTE_KINDS.rejected) {
          fail(
            (split.frame.json as { reason?: string } | undefined)?.reason ??
              'that member refused the connection',
          );
          return;
        }

        // Never expected for a member — a chain that reaches the root is admitted
        // with nothing shown to anybody. Tolerated rather than fatal: it means
        // the other end took us for a joining device, and the refusal or the
        // accept that follows is the answer worth acting on.
        if (kind === REMOTE_KINDS.pendingApproval) continue;

        fail(`that member sent frame kind ${kind} before admitting us`);
        return;
      }
    });

    tls.on('error', (error: Error) => {
      fail(`could not reach ${options.host}:${options.port}: ${error.message}`);
    });

    tls.on('close', () => {
      clearTimeout(deadline);
      if (settled) {
        onClose?.();
        return;
      }
      fail('that member closed the connection before admitting us');
    });
  });
}

function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
