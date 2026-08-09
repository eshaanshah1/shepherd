import type { Disposable } from '@shepherd/sdk';
import type { Endpoint } from './endpoint.ts';
import type { Identity } from './identity.ts';
import type { PairedDevice } from './pairing.ts';

/**
 * What an extension may do with remote — the seam `remote-lan`,
 * `remote-tailscale` and a pairing UI are built on.
 *
 * The line this draws, and it is the whole reason the package exists separately:
 * **remote core is INFRASTRUCTURE.** It terminates TLS, decides pairing, holds
 * the device list and gates the session protocol. It knows nothing about which
 * interface to bind, how a phone discovers a Mac, or what a pairing sheet looks
 * like — those are extensions, exactly as `tasks` is an extension rather than a
 * core noun.
 *
 * Three things follow from that, and each is a decision rather than an omission:
 *
 * **`serve` takes an Endpoint, so a transport is a plug-in.** v1 had no seam
 * here: its LAN listener terminated TLS itself and bridged the raw fd into a
 * server hard-wired to the tailnet through a `socketpair`, because implementing
 * an interface was not an option. `remote-lan` now supplies an `Endpoint` and
 * gets pairing, identity and the session gate for free.
 *
 * **There is no `findDevices`, deliberately.** Discovery is transport-specific —
 * mDNS `_shepherd._tcp` for a LAN, enumerating a tailnet for Tailscale — so it
 * belongs to whichever extension owns that transport. A core verb would have to
 * be the union of every transport's idea of "nearby", which is the shape that
 * has no honest implementation.
 *
 * **`pairingPayload` returns FACTS, not a QR code.** The image is a contributed
 * view's business; core states host, port, pin and code, and something else
 * decides whether that is a QR, a link, or six digits read aloud. Rendering here
 * would put a drawing library in a package that has no page.
 */
export interface RemoteAPI {
  /**
   * Start serving. Disposing stops that endpoint alone.
   *
   * Takes a FACTORY rather than an endpoint, because an endpoint cannot exist
   * before the identity does — it terminates TLS with it — and the identity is
   * core's to load, mint and keep stable. A caller that had to obtain one first
   * would be a caller that decides when this Mac's certificate is created.
   *
   * Several may run at once — loopback for a test, LAN at home, a tailnet
   * elsewhere — because a device pairs with the MAC rather than with a route,
   * and its secret works over whichever one it reaches.
   *
   * **Open question, deliberately recorded rather than guessed at:** the factory
   * receives the identity, so a third-party transport would hold this Mac's
   * PRIVATE KEY. That is acceptable today, when the only implementations are
   * core's own — and it is the wrong shape the moment a third party ships one.
   * The fix is for `Endpoint` to yield RAW connections and for core to wrap them
   * in TLS itself, which is v1's `LANBridge` arrangement as a clean seam rather
   * than a `socketpair`. It is not built now because there is no consumer to
   * shape it against (ADR 0031), and it is written down here so the first
   * third-party transport does not quietly become the moment we hand the key
   * out.
   */
  serve(factory: (identity: Identity, port?: number) => Endpoint): Promise<Disposable>;

  /**
   * Show a pairing code, and return its digits.
   *
   * One device, five minutes, three attempts. Minting a new one invalidates
   * whatever was showing — a code is a moment, not a setting.
   */
  showPairingCode(): string;

  /** The digits currently showing, if any. */
  activeCode(): string | undefined;

  /**
   * Everything a device needs to reach this Mac, as data.
   *
   * `pin` is the certificate hash a client enforces during the handshake — with
   * it, a man in the middle is refused before any human is asked to compare
   * anything, which is why a scanned payload skips the digits entirely.
   */
  pairingPayload(): PairingPayload | undefined;

  devices(): readonly PairedDevice[];

  /**
   * Forget a device and drop its live connections NOW.
   *
   * Immediate rather than eventual because the person revoking is usually doing
   * it because the device is in somebody else's hands.
   */
  revoke(deviceId: string): void;

  /**
   * Approve or deny a device asking to pair.
   *
   * The handler shows whatever UI it likes — a sheet, a notification, a CLI
   * prompt — and answers. Core does not draw, and it cannot: it is loaded by the
   * daemon too, which has no page at all.
   *
   * Only ONE may be registered. Two approval surfaces racing to answer the same
   * request is a design where a device gets in because the slower one was going
   * to say no.
   */
  onPairingRequest(handler: PairingRequestHandler): Disposable;
}

export interface PairingPayload {
  /** How a client addresses this Mac on the endpoint that produced this. */
  readonly host: string;
  readonly port: number;
  /** Lowercase hex SHA-256 of the certificate DER. */
  readonly pin: string;
  /**
   * Where the DATA path listens — the daemon's port, not this one.
   *
   * A device holds two connections: control here, data there. Absent means the
   * daemon is not serving devices yet, and a client that gets a payload without
   * it can pair and browse but cannot open a terminal — which is worth saying
   * rather than letting it look like a dead socket.
   */
  readonly dataPort?: number;
  /** Absent when no code is showing — a payload without one cannot pair. */
  readonly code?: string;
  readonly protocolVersion: number;
}

export interface PairingRequest {
  readonly deviceId: string;
  readonly deviceName: string;
  /** Where it connected from, for a sheet that says "a device on 192.168.1.4". */
  readonly from: string;
  /**
   * The digits a human compares, ABSENT when the client enforced a pin.
   *
   * With a pin there is nothing left to compare — a MITM was refused at the
   * handshake — and asking anyway trains people to confirm digits they have not
   * read, which is the failure the digits exist to prevent.
   */
  readonly sas?: string;
}

export type PairingRequestHandler = (request: PairingRequest) => Promise<boolean>;
