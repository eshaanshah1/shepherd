import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { FrameDecoder, encodeJsonFrame, type Frame } from '@shepherd/core';
import { CONTROL } from './control.ts';
import {
  REMOTE_KINDS,
  certPinOf,
  checkMemberAccept,
  memberHelloFrame,
} from './memberhandshake.ts';
import type { Membership } from './netstore.ts';

/**
 * A live connection to another member, over which this Mac invokes commands.
 *
 * **This is what makes a UI a client of anywhere.** The kernel's rule is that
 * keyboard, palette, CLI, MCP, remote and extensions are transports into ONE
 * command registry (§4.3) — so "show me B's views on A" needs no view-sharing
 * protocol, no mirroring, and no second vocabulary. It needs A to invoke
 * `views.list` on B, which is the same call the phone has always made. What was
 * missing was only that a Mac could not be the caller.
 *
 * **Membership is the whole registration.** There is no code here, no approval,
 * and nothing to configure: a chain that reaches the net's root is admitted, so
 * joining a net is the entire act of two machines becoming reachable to each
 * other. B need never have seen A.
 *
 * It verifies B as strictly as the phone does — chain to the expected root, a
 * signature over a nonce chosen here, and the certificate B's own credential
 * names. `certPin` is what lets this dial an address out of the roster with no
 * pin in hand: the binding is signed by the net rather than copied off a link.
 */

const REMOTE = REMOTE_KINDS;

export interface MemberClientOptions {
  /** This device's membership of the net the target belongs to. */
  readonly membership: Membership;
  readonly host: string;
  readonly port: number;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly now: () => number;
  /** What this Mac serves on, so the member can list it in its own roster. */
  readonly advertise?: { readonly port: number; readonly dataPort?: number };
  /** Per-call deadline. A member that never answers must not wedge a caller. */
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface MemberClient {
  /** Run a command over there. Rejects with the member's own reason. */
  invoke(command: string, args: unknown): Promise<unknown>;
  /** Fires when a contributed view's rows changed and should be re-read. */
  onChanged(listener: (type: string) => void): () => void;
  stop(): void;
}

export const CALL_TIMEOUT_MS = 20_000;

export function memberClient(options: MemberClientOptions): MemberClient {
  const log = options.log ?? (() => undefined);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const changed = new Set<(type: string) => void>();
  let socket: TLSSocket | undefined;
  let ready: Promise<void> | undefined;
  let seq = 1;
  let stopped = false;

  /**
   * One connection, opened on the first call and reused.
   *
   * Lazy because a member that is asleep should cost nothing until somebody
   * actually asks it something, and shared because the control channel keys its
   * answers by `seq` on a single stream.
   */
  function connectOnce(): Promise<void> {
    if (ready !== undefined) return ready;
    ready = new Promise<void>((resolve, reject) => {
      const nonce = randomBytes(16).toString('hex');
      let observedPin = '';

      const fail = (reason: string) => {
        ready = undefined;
        socket?.destroy();
        socket = undefined;
        for (const [id, call] of [...pending]) {
          call.reject(new Error(reason));
          pending.delete(id);
        }
        reject(new Error(reason));
      };

      const tls = connect({ host: options.host, port: options.port, rejectUnauthorized: false }, () => {
        const peer = tls.getPeerX509Certificate();
        if (peer === undefined) {
          fail('that member presented no certificate');
          return;
        }
        // Learned, not trusted: the accept below must produce a credential that
        // names this very certificate, or the connection is refused.
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
      });
      socket = tls;

      const decoder = new FrameDecoder();
      tls.on('data', (chunk: Buffer) => {
        const { frames } = decoder.feed(new Uint8Array(chunk));
        for (const frame of frames) {
          const kind = frame.kind as number;
          if (kind === REMOTE.accepted) {
            const why = checkMemberAccept(frame, options.membership, nonce, observedPin);
            if (why !== undefined) {
              fail(why);
              return;
            }
            log(`connected to ${options.host}:${options.port}`);
            resolve();
            continue;
          }
          if (kind === REMOTE.rejected) {
            fail((frame.json as { reason?: string } | undefined)?.reason ?? 'refused');
            return;
          }
          if (kind === REMOTE.pendingApproval) continue; // never expected for a member
          answer(frame);
        }
      });
      tls.on('error', (error: Error) => fail(`could not reach ${options.host}:${options.port}: ${error.message}`));
      tls.on('close', () => {
        if (!stopped) fail('that member closed the connection');
      });
    });
    return ready;
  }

  /** A CONTROL frame: an answer to somebody waiting, or a change notice. */
  function answer(frame: Frame): void {
    const kind = frame.kind as number;
    if (kind === CONTROL.changed) {
      const type = (frame.json as { type?: string } | undefined)?.type ?? '';
      for (const listener of changed) listener(type);
      return;
    }
    if (kind !== CONTROL.result) return;
    const body = frame.json as {
      seq?: number;
      ok?: boolean;
      value?: unknown;
      error?: { code?: string; message?: string };
    };
    const call = body.seq === undefined ? undefined : pending.get(body.seq);
    if (call === undefined || body.seq === undefined) return;
    pending.delete(body.seq);
    // The member's own words, not a summary of them: "that verb exploded" is
    // what somebody reading a log needs, and a generic failure is what makes a
    // remote call impossible to debug from either end.
    if (body.ok === true) call.resolve(body.value);
    else call.reject(new Error(body.error?.message ?? 'that member refused the command'));
  }

  return {
    async invoke(command, args) {
      if (stopped) throw new Error('this member client was stopped');
      await connectOnce();
      const id = seq;
      seq += 1;
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${command} on ${options.host}:${options.port} did not answer`));
        }, options.timeoutMs ?? CALL_TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket?.write(encodeJsonFrame(CONTROL.invoke as never, { seq: id, command, args }));
      });
    },

    onChanged(listener) {
      changed.add(listener);
      return () => void changed.delete(listener);
    },

    stop() {
      stopped = true;
      for (const [id, call] of [...pending]) {
        call.reject(new Error('this member client was stopped'));
        pending.delete(id);
      }
      socket?.destroy();
      socket = undefined;
      ready = undefined;
    },
  };
}

// `checkMember` used to live here. It is now `checkMemberAccept` in
// `memberhandshake.ts`, shared with the data channel — see that file's comment
// on why two copies of this check is one copy too many.
