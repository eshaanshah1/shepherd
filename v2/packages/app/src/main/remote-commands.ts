import { dialog } from 'electron';
import { toString as qrToString } from 'qrcode';
import type { CommandRegistry } from '@shepherd/core';
import { s, type CategoryLogger, type Disposable } from '@shepherd/sdk';
import { encodeJoinURI, type RemoteAPI } from '@shepherd/remote';

/**
 * Nets, as verbs and one dialog.
 *
 * Deliberately NOT a settings pane. Everything here is reachable from the
 * palette and from the CLI the moment it is registered, because it is in the one
 * verb table — so `shepherd raw remote.pair` works with no UI written at all,
 * and a contributed view can draw a prettier version later without this becoming
 * a second implementation of it (§4.3, and v1's three routing paths).
 */

export const REMOTE_COMMANDS = {
  pair: 'remote.pair',
  members: 'remote.members',
  revoke: 'remote.revoke',
  nets: 'remote.nets',
  createNet: 'remote.createNet',
  useNet: 'remote.useNet',
  joinNet: 'remote.join',
  leaveNet: 'remote.leaveNet',
} as const;

export interface RemoteCommandsOptions {
  readonly remote: RemoteAPI;
  readonly registry: CommandRegistry;
  readonly log: CategoryLogger;
}

export function registerRemoteCommands(options: RemoteCommandsOptions): Disposable {
  const { remote, registry, log } = options;

  /**
   * The approval, and the reason it is a modal dialog rather than a banner.
   *
   * A device is asking to drive this machine. That is a decision, and a decision
   * that can be missed is a decision that gets made by whoever is patient — so
   * it blocks, and the default button is the SAFE one.
   *
   * v1's rule about three-digit comparison is not needed here and it would be
   * worse than useless: the phone enforces the certificate pin during the
   * handshake, so a man in the middle was refused before this ran, and asking a
   * human to compare digits anyway teaches them to confirm numbers they have not
   * read. When `sas` IS present — a client that did not pin — the digits are
   * shown, because then there is something real to compare.
   */
  const approval = remote.onJoinRequest(async (request) => {
    const net = remote.activeNet();
    const detail = [
      `${request.deviceName} at ${request.from} wants to join ${net?.name ?? 'this net'}.`,
      'Every Mac in the net will admit it from then on, with no further approval.',
      request.sas === undefined
        ? 'It verified this Mac’s certificate, so there are no digits to compare.'
        : `Check the phone shows: ${request.sas}`,
    ].join('\n\n');

    const answer = await dialog.showMessageBox({
      type: 'question',
      message: 'Let this device into your net?',
      detail,
      buttons: ['Allow', "Don't allow"],
      defaultId: 1,
      cancelId: 1,
    });
    const allowed = answer.response === 0;
    log.info(`join ${allowed ? 'allowed' : 'refused'} for ${request.deviceName}`);
    return allowed;
  });

  const subscriptions: Disposable[] = [
    approval,

    registry.register(REMOTE_COMMANDS.pair, {
      title: 'Remote: Add a Device to This Net',
      permission: 'views',
      schema: s.nothing(),
      /**
       * Mints a code and hands back everything a device needs — three ways.
       *
       * Minted HERE rather than at startup because a code is a moment, not a
       * setting: five minutes, three attempts, one device. A code showing since
       * boot is a code anybody who walked past has had time to use.
       *
       * **The QR is not decoration.** Joining means carrying a host, a port, a
       * 64-character certificate pin and an 88-character root key to the other
       * device; typed by hand that is done once and never again. So the answer
       * carries the facts (for a UI), one `shepherd://join` URI (to paste), and
       * that URI as a QR block (to point a phone at) — one payload, three ways
       * in, and one parser on the other side rather than one per surface.
       */
      handler: async () => {
        const code = remote.showPairingCode();
        const payload = remote.pairingPayload();
        if (payload === undefined) {
          throw new Error(
            remote.activeNet() === undefined
              ? 'this Mac is in no net yet — run remote.createNet first'
              : 'remote is not serving — nothing to join yet',
          );
        }
        const uri = encodeJoinURI(payload);
        // Logged as well as returned, so the whole thing is readable from a
        // terminal pane with no UI in existence.
        log.info(`join code ${code} — ${uri}`);
        return { ...payload, uri, qr: await qr(uri) };
      },
    }),

    registry.register(REMOTE_COMMANDS.members, {
      title: 'Remote: Members of This Net',
      permission: 'views',
      schema: s.nothing(),
      /**
       * The roster, which holds no secrets to leak — that was the pairwise
       * model's problem, where a device list sat next to the secret proving each
       * one. Membership is a signed credential the device itself holds; this is
       * names and last-known addresses.
       */
      handler: () =>
        remote.members().map((member) => ({
          id: member.memberId,
          name: member.name,
          addrs: member.addrs,
          admittedBy: member.admittedBy,
          admittedAt: member.admittedAt,
        })),
    }),

    registry.register(REMOTE_COMMANDS.revoke, {
      title: 'Remote: Revoke a Member',
      permission: 'views',
      schema: s.object({ device: s.string() }),
      handler: (args: { device: string }) => {
        remote.revoke(args.device);
        return { revoked: args.device };
      },
    }),

    registry.register(REMOTE_COMMANDS.nets, {
      title: 'Remote: Nets',
      permission: 'views',
      schema: s.nothing(),
      handler: () => ({ nets: remote.nets(), active: remote.activeNet()?.netId }),
    }),

    registry.register(REMOTE_COMMANDS.createNet, {
      title: 'Remote: Create a Net',
      permission: 'views',
      schema: s.object({ name: s.string() }),
      handler: (args: { name: string }) => remote.createNet(args.name),
    }),

    registry.register(REMOTE_COMMANDS.useNet, {
      title: 'Remote: Switch Net',
      permission: 'views',
      schema: s.object({ net: s.string() }),
      handler: (args: { net: string }) => {
        remote.setActiveNet(args.net);
        return { active: args.net };
      },
    }),

    registry.register(REMOTE_COMMANDS.joinNet, {
      title: 'Remote: Join a Net',
      permission: 'views',
      schema: s.object({ link: s.string() }),
      /**
       * The other end of `remote.pair`: paste the link that Mac printed.
       *
       * It blocks until a human over there answers, which can be a while — and
       * that is better than returning "asked" and leaving the caller to poll for
       * an outcome it cannot name.
       */
      handler: async (args: { link: string }) => remote.joinNet(args.link),
    }),

    registry.register(REMOTE_COMMANDS.leaveNet, {
      title: 'Remote: Leave a Net',
      permission: 'views',
      schema: s.object({ net: s.string() }),
      handler: (args: { net: string }) => {
        remote.leaveNet(args.net);
        return { left: args.net };
      },
    }),
  ];

  return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
}

/**
 * The join URI as a block of text a camera can read.
 *
 * `small: true` uses half-height blocks, which is what keeps a payload this long
 * inside a normal terminal window — at full height it wraps, and a wrapped QR is
 * not a QR. A failure here returns empty rather than throwing: the URI beside it
 * still works, and losing the whole pairing verb because a renderer complained
 * would be a poor trade.
 */
async function qr(uri: string): Promise<string> {
  try {
    return await qrToString(uri, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
  } catch {
    return '';
  }
}
