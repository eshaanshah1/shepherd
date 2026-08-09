import { dialog } from 'electron';
import type { CommandRegistry } from '@shepherd/core';
import { s, type CategoryLogger, type Disposable } from '@shepherd/sdk';
import type { RemoteAPI } from '@shepherd/remote';

/**
 * Pairing, as verbs and one dialog.
 *
 * Deliberately NOT a settings pane. Everything here is reachable from the
 * palette and from the CLI the moment it is registered, because it is in the one
 * verb table — so `shepherd raw remote.pair` works with no UI written at all,
 * and a contributed view can draw a prettier version later without this becoming
 * a second implementation of it (§4.3, and v1's three routing paths).
 */

export const REMOTE_COMMANDS = {
  pair: 'remote.pair',
  devices: 'remote.devices',
  revoke: 'remote.revoke',
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
  const approval = remote.onPairingRequest(async (request) => {
    const detail = [
      `${request.deviceName} at ${request.from} wants to drive this Mac.`,
      request.sas === undefined
        ? 'It verified this Mac’s certificate, so there are no digits to compare.'
        : `Check the phone shows: ${request.sas}`,
    ].join('\n\n');

    const answer = await dialog.showMessageBox({
      type: 'question',
      message: 'Allow this device?',
      detail,
      buttons: ['Allow', "Don't allow"],
      defaultId: 1,
      cancelId: 1,
    });
    const allowed = answer.response === 0;
    log.info(`pairing ${allowed ? 'allowed' : 'refused'} for ${request.deviceName}`);
    return allowed;
  });

  const subscriptions: Disposable[] = [
    approval,

    registry.register(REMOTE_COMMANDS.pair, {
      title: 'Remote: Pair a Device',
      permission: 'views',
      schema: s.nothing(),
      /**
       * Mints a code and hands back everything a device needs.
       *
       * Minted HERE rather than at startup because a code is a moment, not a
       * setting: five minutes, three attempts, one device. A code showing since
       * boot is a code anybody who walked past has had time to use.
       */
      handler: () => {
        const code = remote.showPairingCode();
        const payload = remote.pairingPayload();
        if (payload === undefined) {
          throw new Error('remote is not serving — nothing to pair with yet');
        }
        // Logged as well as returned, so it is readable from a terminal pane
        // without a UI existing.
        log.info(`pairing code ${code} — ${payload.host}:${payload.port}`);
        return payload;
      },
    }),

    registry.register(REMOTE_COMMANDS.devices, {
      title: 'Remote: Paired Devices',
      permission: 'views',
      schema: s.nothing(),
      // The secret is deliberately NOT in the answer. It is this Mac's proof
      // that a device is who it says; a verb that handed it back would make
      // every caller of a read-only list a place it can leak from.
      handler: () =>
        remote.devices().map((device) => ({
          id: device.id,
          name: device.name,
          pairedAt: device.pairedAt,
          lastSeenAt: device.lastSeenAt,
        })),
    }),

    registry.register(REMOTE_COMMANDS.revoke, {
      title: 'Remote: Revoke a Device',
      permission: 'views',
      schema: s.object({ device: s.string() }),
      handler: (args: { device: string }) => {
        remote.revoke(args.device);
        return { revoked: args.device };
      },
    }),
  ];

  return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
}
