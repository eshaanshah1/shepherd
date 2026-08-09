import { s, type KV } from '@shepherd/sdk';
import type { DeviceStore } from './server.ts';
import type { PairedDevice } from './pairing.ts';

/**
 * Paired devices, in THE store.
 *
 * It was a JSON file for one run, and that was wrong for a reason worth writing
 * down: this repo has exactly one persistence mechanism on purpose (ADR 0021 —
 * `node:sqlite`, stdlib, so no native build against Electron's ABI), and a
 * second one means two migration stories, two shapes to validate, and a file
 * with no schema version at precisely the place a future field will need one.
 * The atomic rename and hand-rolled shape check it grew were re-implementing,
 * badly, what the store already does.
 *
 * Both processes open the same database — SQLite is built for that — which is
 * what lets a device pair ONCE and connect twice: control to the app, data to
 * the daemon, one record.
 *
 * Only the app ever writes a NEW device, because only the app can show an
 * approval. The daemon reads. So a headless process cannot admit a stranger,
 * which is what makes sharing this safe rather than merely convenient.
 */

const KEY = 'paired';

/**
 * Declared rather than cast: it comes off disk, an older build may have written
 * it, and `KV.get` takes a schema for exactly this reason. A half-written record
 * must not become a device that pairs and then fails somewhere far from here.
 */
const DEVICES = s.array(
  s.object({
    id: s.string(),
    name: s.string(),
    secret: s.string(),
    pin: s.string(),
    pairedAt: s.number(),
    lastSeenAt: s.number(),
  }),
);

export function kvDeviceStore(kv: KV): DeviceStore {
  /**
   * Read on EVERY call rather than cached.
   *
   * Two processes share this, so a cache would be one of them believing a device
   * is still paired after the other revoked it — and the whole point of revoking
   * is that it takes effect now. It is a handful of rows read on a connection
   * attempt, not a hot path.
   */
  const all = (): readonly PairedDevice[] => kv.get(KEY, DEVICES) ?? [];

  return {
    all,
    put: (device) => kv.set(KEY, [...all().filter((candidate) => candidate.id !== device.id), device]),
    remove: (id) => kv.set(KEY, all().filter((candidate) => candidate.id !== id)),
  };
}
