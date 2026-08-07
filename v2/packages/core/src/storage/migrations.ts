import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, forward-only, applied in order, each in its own
 * transaction. The current version is SQLite's own `PRAGMA user_version`.
 *
 * `user_version` rather than a `meta` row on purpose: it is a header field, so
 * it moves atomically with the transaction that earned it, and no namespace
 * wipe or `DELETE FROM` can take it out. A version marker that a data operation
 * can erase is a version marker that will one day read 0 on a populated file
 * and re-run every migration.
 *
 * Rules for adding one: append, never edit. An edited migration has already run
 * on somebody's machine (including yours, three commits ago), so editing it
 * changes the schema for new installs only — which is the same file format
 * meaning two different things.
 */
export interface Migration {
  /** 1-based and contiguous; asserted at startup. */
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'kv',
    up(db) {
      // Namespaced key/value, one row per key. The composite primary key is what
      // makes a write `select-by-id` rather than v1's read-modify-write of one
      // big blob — two extensions saving at once cannot clobber each other, and
      // a single key changing costs one row.
      db.exec(`
        CREATE TABLE kv (
          namespace TEXT NOT NULL,
          key       TEXT NOT NULL,
          value     TEXT NOT NULL,
          PRIMARY KEY (namespace, key)
        ) WITHOUT ROWID
      `);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.length;
