# 0025. (v2) The kernel injects the correlation env, and a vendor extension cannot

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only.

## Context
Core-design §5.2 and the M2 handoff both assign env injection to the
`claude-code` extension: `sessions.onWillCreate` → inject `SHEPHERD_SESSION_ID`
and the ingress socket path, preserving ADR 0003's correlation-by-env-var.

It cannot be built that way, and the reason is structural rather than a matter of
effort. `SessionHost.onWillCreate` is **synchronous by documented design**:
`create` returns a `SessionID` the layout needs in the same tick, so an async
hook would make session creation a promise and every caller a state machine
(`packages/core/src/session/host.ts`). Extensions run in a utility process
(sketch §7b) reached only by request/response over a message port. A synchronous
callback cannot cross one — not *yet*, but not in this shape, ever.

The file already names the way out: *"a hook that needs IO does it at
registration time and closes over the answer."*

## Decision
**`main/index.ts` registers one in-process `onWillCreate` hook, and every session
gets `SHEPHERD_SESSION_ID`, `SHEPHERD_EVENTS_SOCK` and `SHEPHERD_CONTROL_SOCK`
whether or not any agent extension is loaded.**

This is a deviation from §5.2, and the justification is that the values were
never vendor-specific. `SessionID` is core's own declared correlation key ("THE
correlation key, everywhere"), and the sockets are core's own front door. **v1
agrees**: the *app* injected the env per pane and the plugin only ever read it.
`claude-code` keeps everything that is actually about Claude — the plugin, the
`claude.hook` subscriber, `StopPolicy`, resume — and loses only the part that was
never its own.

**Considered and rejected:** a declarative env contribution — a new `ApiCall`
carrying `Record<string,string>` with `${sessionId}` placeholders, expanded
main-side by the host. It is buildable and preserves §5.2's letter. It buys
nothing: the machinery would exist so an extension could declare two constants
the kernel already owns, and every extension would then have to be trusted not to
declare a *third* thing that lies about a session's identity.

`sessions.onWillCreate` therefore stays typed in the SDK and refuses across the
port, with its reason naming the synchronous callback rather than a milestone.

## Consequences
- Correlation works for every session, including ones no agent extension knows
  about — which is what the control CLI and (later) remote need anyway.
- An extension cannot mint or alter a session's identity. That was implicit
  before and is now structural.
- A future extension with a *genuine* per-draft need (something computed from the
  cwd, say) has no seam. That is deliberate: the seam should be designed against
  a real consumer, and there isn't one. The refusal says so at the call.
- **A refusal reason that names a milestone rots.** This one said "lands in M2"
  until M2 landed and made it false. Reasons name mechanisms now.
