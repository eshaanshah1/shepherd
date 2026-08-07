// Persistence. One store, `node:sqlite` (stdlib — nothing to rebuild against
// Electron's ABI), versioned by `PRAGMA user_version`, namespaced per consumer.
export { SqliteStore, type SqliteStoreOptions } from './store.ts';
export { MIGRATIONS, LATEST_VERSION, type Migration } from './migrations.ts';
