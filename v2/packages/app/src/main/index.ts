// The main process's own surface. P2 lands the session half: the kernel-facing
// bridge and its electron adapter. The window, the menu and the single-instance
// lock arrive in P3/P4 and wire to exactly these.
export {
  SessionBridge,
  type RendererTarget,
  type SessionBridgeOptions,
  type SessionHostLike,
} from './session-bridge.ts';
export { registerSessionIpc } from './ipc.ts';
