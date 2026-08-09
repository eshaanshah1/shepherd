import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, manualClock, s, type LogRecord, type Logger } from '@shepherd/sdk';
import { SqliteStore, type Migration } from './store.ts';
import { MIGRATIONS } from './migrations.ts';

let records: LogRecord[] = [];
let logger: Logger;

beforeEach(() => {
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_line, record) => records.push(record) });
});

const messages = () => records.map((r) => r.message);
const memory = () => new SqliteStore({ location: ':memory:', logger });

describe('kv round-trip', () => {
  it('stores and reads a validated value', () => {
    const kv = memory().namespace('shepherd.tasks');
    kv.set('lastRepo', { path: '/src/app', uses: 3 });
    expect(kv.get('lastRepo', s.object({ path: s.string(), uses: s.int() }))).toEqual({
      path: '/src/app',
      uses: 3,
    });
  });

  it('an absent key is undefined, not an error', () => {
    expect(memory().namespace('ns').get('nope', s.string())).toBeUndefined();
  });

  it('set twice updates in place — one row, last value', () => {
    const kv = memory().namespace('ns');
    kv.set('k', 'first');
    kv.set('k', 'second');
    expect(kv.get('k', s.string())).toBe('second');
    expect(kv.keys()).toEqual(['k']);
  });

  it('namespaces are isolated', () => {
    const store = memory();
    store.namespace('a').set('k', 1);
    store.namespace('b').set('k', 2);
    expect(store.namespace('a').get('k', s.number())).toBe(1);
    expect(store.namespace('b').get('k', s.number())).toBe(2);
    expect(store.namespace('a').keys()).toEqual(['k']);
  });

  it('delete removes only that key', () => {
    const kv = memory().namespace('ns');
    kv.set('keep', 1);
    kv.set('drop', 2);
    kv.delete('drop');
    expect(kv.keys()).toEqual(['keep']);
  });

  it('keys() is sorted, so a caller never depends on insertion order', () => {
    const kv = memory().namespace('ns');
    kv.set('c', 1);
    kv.set('a', 1);
    kv.set('b', 1);
    expect(kv.keys()).toEqual(['a', 'b', 'c']);
  });

  it('round-trips the awkward JSON values', () => {
    const kv = memory().namespace('ns');
    kv.set('empty', {});
    kv.set('nested', { a: [1, { b: null }] });
    kv.set('unicode', 'ẛ̣ — 🐑');
    expect(kv.get('empty', s.object({}))).toEqual({});
    expect(kv.get('unicode', s.string())).toBe('ẛ̣ — 🐑');
    expect(kv.get('nested', s.unknown())).toEqual({ a: [1, { b: null }] });
  });
});

describe('a stored value that no longer matches', () => {
  it('reads as absent and logs, rather than throwing', () => {
    // The value on disk was written by an earlier version of this code. A throw
    // here happens on a restore path, which means a bad blob would stop the app
    // from starting — the failure mode this whole discipline exists to avoid.
    const kv = memory().namespace('ns');
    kv.set('cols', 'eighty');
    expect(kv.get('cols', s.int())).toBeUndefined();
    expect(messages().some((m) => m.includes('ns/cols') && m.includes('schema'))).toBe(true);
  });

  it('survives a value that is not JSON at all', () => {
    const store = memory();
    store.db.prepare('INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)').run('ns', 'k', '{not json');
    expect(store.namespace('ns').get('k', s.unknown())).toBeUndefined();
    expect(messages().some((m) => m.includes('not JSON'))).toBe(true);
  });
});

describe('migrations', () => {
  it('a fresh store lands on the latest version', () => {
    expect(memory().version).toBe(MIGRATIONS.length);
  });

  it('applies each step once, in order', () => {
    const applied: number[] = [];
    const list: Migration[] = [
      { version: 1, name: 'one', up: (db) => { applied.push(1); db.exec('CREATE TABLE a (x)'); } },
      { version: 2, name: 'two', up: (db) => { applied.push(2); db.exec('CREATE TABLE b (x)'); } },
    ];
    const store = new SqliteStore({ location: ':memory:', logger, migrations: list });
    expect(applied).toEqual([1, 2]);
    expect(store.version).toBe(2);
  });

  it('rejects a non-contiguous list before touching the database', () => {
    const list: Migration[] = [
      { version: 1, name: 'one', up: () => {} },
      { version: 3, name: 'three', up: () => {} },
    ];
    expect(() => new SqliteStore({ location: ':memory:', logger, migrations: list })).toThrow(/contiguous/);
  });

  it('a failing migration rolls back and leaves the version where it was', () => {
    const list: Migration[] = [
      { version: 1, name: 'ok', up: (db) => db.exec('CREATE TABLE t (x)') },
      {
        version: 2,
        name: 'broken',
        up: (db) => {
          db.exec('CREATE TABLE t2 (x)');
          throw new Error('nope');
        },
      },
    ];
    expect(() => new SqliteStore({ location: ':memory:', logger, migrations: list })).toThrow('nope');
    expect(messages().some((m) => m.includes('migration 2') && m.includes('broken'))).toBe(true);
  });
});

describe('on disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const path = () => join(dir, 'shepherd.db');

  it('persists across a close and reopen', () => {
    const first = new SqliteStore({ location: path(), logger });
    first.namespace('ns').set('k', 'survives');
    first.close();

    const second = new SqliteStore({ location: path(), logger });
    expect(second.namespace('ns').get('k', s.string())).toBe('survives');
    second.close();
  });

  /**
   * Two processes really do share this file — the daemon serves paired devices
   * their ptys and reads the same pairings the app writes — and on SQLite's
   * defaults that combination throws `database is locked` out of an ordinary
   * SELECT. It killed the daemon, and with it every terminal the user had open,
   * the first time a phone connected while the app was writing.
   */
  it('opens WAL with a busy timeout, because two processes share this file', () => {
    const store = new SqliteStore({ location: path(), logger });
    const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    const busy = store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(busy.timeout).toBeGreaterThan(0);
    store.close();
  });

  it('lets a second connection read while the first holds the file', () => {
    const writer = new SqliteStore({ location: path(), logger });
    writer.namespace('devices').set('paired', 'one');

    // The daemon's connection: opened second, against a live file, and it must
    // be able to read without waiting on the app to be idle.
    const reader = new SqliteStore({ location: path(), logger });
    writer.namespace('devices').set('paired', 'two');
    expect(reader.namespace('devices').get('paired', s.string())).toBe('two');
    // …and write back, which is what recording `lastSeenAt` does.
    expect(() => reader.namespace('devices').set('paired', 'three')).not.toThrow();
    expect(writer.namespace('devices').get('paired', s.string())).toBe('three');

    reader.close();
    writer.close();
  });

  it('reopening does not re-run migrations', () => {
    // The version is in `PRAGMA user_version`, a header field, so it moves with
    // the transaction that earned it. A `meta` row could be deleted by a data
    // operation and then every migration would re-run on a populated file.
    const applied: number[] = [];
    const list: Migration[] = [
      { version: 1, name: 'one', up: (db) => { applied.push(1); db.exec('CREATE TABLE a (x)'); } },
    ];
    new SqliteStore({ location: path(), logger, migrations: list }).close();
    new SqliteStore({ location: path(), logger, migrations: list }).close();
    expect(applied).toEqual([1]);
  });

  it('upgrades an existing file by applying only the new steps', () => {
    const one: Migration = { version: 1, name: 'one', up: (db) => db.exec('CREATE TABLE a (x)') };
    new SqliteStore({ location: path(), logger, migrations: [one] }).close();

    const applied: string[] = [];
    const two: Migration = {
      version: 2,
      name: 'two',
      up: (db) => {
        applied.push('two');
        db.exec('CREATE TABLE b (x)');
      },
    };
    const upgraded = new SqliteStore({ location: path(), logger, migrations: [one, two] });
    expect(applied).toEqual(['two']);
    expect(upgraded.version).toBe(2);
    upgraded.close();
  });

  it('REFUSES a file written by a newer build', () => {
    // Opening it read-write would let this build write rows the newer schema
    // cannot read back — quiet corruption in exchange for a successful launch.
    const list: Migration[] = [
      { version: 1, name: 'one', up: (db) => db.exec('CREATE TABLE a (x)') },
      { version: 2, name: 'two', up: (db) => db.exec('CREATE TABLE b (x)') },
    ];
    new SqliteStore({ location: path(), logger, migrations: list }).close();

    expect(() => new SqliteStore({ location: path(), logger, migrations: [list[0]!] })).toThrow(
      /newer Shepherd/,
    );
  });
});
