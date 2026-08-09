// The daemon's public face — what a test or the app may import. `main.ts` is the
// entry point and is deliberately NOT exported: it binds a socket on import.
export { SessionServer, type Connection, type SessionServerOptions } from './server.ts';
