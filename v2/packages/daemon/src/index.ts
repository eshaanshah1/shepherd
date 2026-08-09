// The daemon's public face — what a test may import. `main.ts` is the entry
// point and is deliberately NOT exported: it binds a socket on import.
//
// `SessionServer` moved to `@shepherd/core` when `@shepherd/remote` needed it
// too: it is the session PROTOCOL's server, and this package is one process
// that hosts it rather than its owner.
export { SessionServer, type Connection, type SessionServerOptions } from '@shepherd/core';
export { parseArgs, type Args } from './main.ts';
