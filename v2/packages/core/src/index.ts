// @shepherd/core — the kernel.
//
// P0 lands the package and its boundaries only. The two directories the design
// names arrive next:
//   src/layout/   — the SplitTree port (P1)
//   src/session/  — SessionHost + PtyRing (P1 ring, P2 host)
export { newSessionId, newPaneId } from './identity.ts';
