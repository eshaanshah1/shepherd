import { DatabaseSync } from 'node:sqlite';
import type { KV, Logger, Schema } from '@shepherd/sdk';
import { LATEST_VERSION, MIGRATIONS, type Migration } from './migrations.ts';

/**
 * The one store. `node:sqlite` — stdlib, so no native dependency and nothing to
 * rebuild against Electron's ABI (measured against Electron 43.3.0 / Node
 * 24.18.1 before this was written; `better-sqlite3`, which the design named, is
 * superseded by it).
 *
 * What it replaces: 34 string-literal UserDefaults keys, a whole-blob JSON
 * re-encode on every change, and index-based selection that broke when a list
 * reordered (review §Bad-8). The discipline that replaces them is structural
 * rather than remembered — a namespace is a value, a write is one row, and the
 * schema version is a header field.
 *
 * Rule from §7b, worth keeping in view: **machines write DBs, humans write
 * files.** Nothing a user is expected to hand-edit belongs in here; user config
 * stays text.
 */

export interface SqliteStoreOptions {
  /** A path, or `':memory:'` for a test. */
  readonly location: string;
  readonly logger: Logger;
  /** Overridable so a test can drive a partial or a broken sequence. */
  readonly migrations?: readonly Migration[];
}

export class SqliteStore {
  readonly #db: DatabaseSync;
  readonly #log;

  constructor(options: SqliteStoreOptions) {
    this.#log = options.logger.child('storage');
    this.#db = new DatabaseSync(options.location);
    // Foreign keys are off by default in SQLite and are per-connection, so this
    // has to be said here rather than in a migration.
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate(options.migrations ?? MIGRATIONS);
  }

  /** A caller's own slice of the store. The namespace is never re-derived. */
  namespace(name: string): KV {
    return new NamespacedKV(this.#db, name, this.#log);
  }

  get version(): number {
    return readUserVersion(this.#db);
  }

  /** Escape hatch for core's own tables (tasks, layout). Not exposed to extensions. */
  get db(): DatabaseSync {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  #migrate(migrations: readonly Migration[]): void {
    assertContiguous(migrations);
    const from = readUserVersion(this.#db);
    const target = migrations.length;

    if (from > target) {
      // A file written by a NEWER build. Migrating down is not a thing we do, and
      // opening it read-write would let this build write rows the new schema
      // cannot read back. Refuse loudly rather than corrupt quietly.
      throw new Error(
        `store is at schema version ${from} but this build knows only ${target}. ` +
          'Refusing to open a database written by a newer Shepherd.',
      );
    }
    if (from === target) return;

    for (const migration of migrations.slice(from)) {
      // One transaction per migration: a failure leaves the version where it was,
      // so the next launch retries THAT migration rather than half of it.
      this.#db.exec('BEGIN');
      try {
        migration.up(this.#db);
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        this.#log.error(`migration ${migration.version} (${migration.name}) failed: ${messageOf(error)}`);
        throw error;
      }
      this.#log.info(`migrated to ${migration.version} (${migration.name})`);
    }
  }
}

/**
 * One extension's (or one subsystem's) keys.
 *
 * `get` takes the schema at the call site rather than at registration: the value
 * on disk was written by some earlier version of this code, and the *reader* is
 * the only one who knows what it expects today. A value that no longer matches
 * is treated as absent and logged — never thrown. A stored blob that fails
 * validation must not be able to stop the app from starting, which is exactly
 * what an exception on a restore path does.
 */
class NamespacedKV implements KV {
  readonly #db: DatabaseSync;
  readonly #ns: string;
  readonly #log: ReturnType<Logger['child']>;

  constructor(db: DatabaseSync, namespace: string, log: ReturnType<Logger['child']>) {
    this.#db = db;
    this.#ns = namespace;
    this.#log = log;
  }

  get<T>(key: string, schema: Schema<T>): T | undefined {
    const row = this.#db.prepare('SELECT value FROM kv WHERE namespace = ? AND key = ?').get(this.#ns, key) as
      | { value: string }
      | undefined;
    if (row === undefined) return undefined;

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch (error) {
      this.#log.warn(`${this.#ns}/${key} is not JSON, treating as absent: ${messageOf(error)}`);
      return undefined;
    }

    const parsed = schema.parse(decoded);
    if (!parsed.ok) {
      this.#log.warn(
        `${this.#ns}/${key} does not match its schema, treating as absent: ` +
          parsed.error.map((i) => `${i.path} ${i.message}`).join('; '),
      );
      return undefined;
    }
    return parsed.value;
  }

  set<T>(key: string, value: T): void {
    this.#db
      .prepare(
        'INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?) ' +
          'ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value',
      )
      .run(this.#ns, key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM kv WHERE namespace = ? AND key = ?').run(this.#ns, key);
  }

  keys(): readonly string[] {
    const rows = this.#db
      .prepare('SELECT key FROM kv WHERE namespace = ? ORDER BY key')
      .all(this.#ns) as { key: string }[];
    return rows.map((row) => row.key);
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Versions must be 1..n with no holes. A gap would make `slice(from)` apply the
 * wrong subset, which is the kind of bug that only shows up on the one machine
 * that upgraded from the version inside the gap.
 */
function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `migration list is not contiguous: entry ${index} declares version ${migration.version}, expected ${index + 1}`,
      );
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { LATEST_VERSION, MIGRATIONS, type Migration };
