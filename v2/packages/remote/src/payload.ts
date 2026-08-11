import { REMOTE_PROTOCOL_VERSION } from './join.ts';
import { netIdOf } from './netcrypto.ts';

/**
 * Everything a device needs to join a net, as ONE string.
 *
 * **Why a single string rather than fields on a screen.** Joining otherwise means
 * copying a host, a port, a 64-character pin and an 88-character root key onto a
 * phone by hand, and nobody does that twice. One string is a QR, a pasted line in
 * a message, or an argument to the CLI — the same payload every way in, so there
 * is one parser to be right rather than one per surface.
 *
 * **A URI rather than base64 JSON**, so a human can read what they are about to
 * join and a log line stays legible: `shepherd://join?host=…&net=…`. It costs
 * nothing in QR size at this length.
 *
 * **The payload checks itself.** The net id is the SHA-256 of the root key the
 * payload carries, so a link naming one net while carrying another net's key is
 * refused here, before a byte is sent. What this does NOT do is tell you the link
 * came from a Mac you trust — that is the join ceremony's job (a code, and digits
 * a human compares), and this is only how the facts travel.
 */

export interface PairingPayload {
  /** How a client addresses this Mac on the endpoint that produced this. */
  readonly host: string;
  readonly port: number;
  /**
   * Where the DATA path listens — the daemon's port, not this one.
   *
   * A device holds two connections: control here, data there. Absent means the
   * daemon is not serving devices yet, and a client that gets a payload without
   * it can join and browse but cannot open a terminal — worth saying rather than
   * letting it look like a dead socket.
   */
  readonly dataPort?: number;
  /** Lowercase hex SHA-256 of this Mac's certificate DER. */
  readonly pin: string;
  /** Absent when no code is showing — a payload without one cannot join. */
  readonly code?: string;
  /** Hex SHA-256 of the net's root public key. */
  readonly netId: string;
  readonly netName: string;
  /**
   * The net's root public key, hex SPKI DER.
   *
   * Carried because a member with no root key can never CHECK anybody: it would
   * hold a credential and no way to verify the next Mac it met. The accept
   * repeats it, so a device that joined by code alone is not left without one.
   */
  readonly rootPublicKey: string;
  readonly protocolVersion: number;
}

export const JOIN_SCHEME = 'shepherd://join';

export function encodeJoinURI(payload: PairingPayload): string {
  const fields: Array<[string, string]> = [
    ['v', String(payload.protocolVersion)],
    ['host', payload.host],
    ['port', String(payload.port)],
    ...(payload.dataPort === undefined
      ? []
      : ([['data', String(payload.dataPort)]] as Array<[string, string]>)),
    ['pin', payload.pin],
    ...(payload.code === undefined ? [] : ([['code', payload.code]] as Array<[string, string]>)),
    ['net', payload.netId],
    ['name', payload.netName],
    ['root', payload.rootPublicKey],
  ];
  return `${JOIN_SCHEME}?${fields
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

/**
 * Undefined for anything this build cannot act on — and every refusal is one a
 * caller can explain, which is the reason this is total rather than a throw.
 */
export function parseJoinURI(uri: string): PairingPayload | undefined {
  if (!uri.startsWith(`${JOIN_SCHEME}?`)) return undefined;

  const fields = new Map<string, string>();
  for (const pair of uri.slice(`${JOIN_SCHEME}?`.length).split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    if (at < 0) continue;
    fields.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
  }

  const host = fields.get('host');
  const pin = fields.get('pin');
  const netId = fields.get('net');
  const rootPublicKey = fields.get('root');
  if (host === undefined || pin === undefined || netId === undefined || rootPublicKey === undefined) {
    return undefined;
  }

  const version = number(fields.get('v'));
  // A device that speaks another protocol version cannot be told so by the Mac
  // — it would have to connect first, and its refusal would arrive as a network
  // error. Caught here, the message can name both versions.
  if (version !== REMOTE_PROTOCOL_VERSION) return undefined;

  const port = number(fields.get('port'));
  if (port === undefined || port <= 0) return undefined;

  const dataPort = fields.has('data') ? number(fields.get('data')) : undefined;
  if (fields.has('data') && dataPort === undefined) return undefined;

  // The two halves of the net's identity must agree. A mismatch is a link that
  // was tampered with or truncated, and dialling it would end in a refusal that
  // named nothing.
  if (safeNetId(rootPublicKey) !== netId.toLowerCase()) return undefined;

  const code = fields.get('code');
  return {
    host,
    port,
    ...(dataPort === undefined ? {} : { dataPort }),
    pin,
    ...(code === undefined ? {} : { code }),
    netId,
    netName: fields.get('name') ?? '',
    rootPublicKey,
    protocolVersion: version,
  };
}

function number(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Hashing a string a stranger sent, so a malformed key is a refusal not a throw. */
function safeNetId(rootPublicKey: string): string | undefined {
  try {
    return netIdOf(rootPublicKey);
  } catch {
    return undefined;
  }
}
