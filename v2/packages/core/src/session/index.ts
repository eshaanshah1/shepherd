// The session half of the kernel. P1 lands the two pure pieces the host is
// built out of — the replay ring and the record-and-fan-out seam over it.
// `SessionHost` (node-pty, registry, env-injection hook) arrives in P2 and owns
// one `PtyFanout` per session.
export { PtyRing } from './ring.ts';
export { PtyFanout, type PtySink } from './fanout.ts';
