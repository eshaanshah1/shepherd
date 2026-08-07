# 0027. (v2) The hook envelope carries no client sequence, and no `jq`

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only. v1's `report.sh` is untouched and maintenance-only.

## Context
Two prescriptions were carried into M2 from the architecture review, core-design
§4.4/§5.2 and the M2 handoff. Both were right about the problem and one step
behind the solution, because both predate the decision that the hook payload
rides **whole** and is parsed in TypeScript.

**`seq`.** The proposal was a per-session sequence number on the envelope so the
`PreToolUse`/`PermissionRequest` race would be *detectable*. Implemented as
specified — a counter file, read-increment-write, no lock (stock macOS has no
`flock`) — two concurrent hooks both read N and both POST `seq: N+1`. The bus
then treats the second as a **duplicate** and `return`s **before the fan-out**
(`envelope.ts`'s `seqVerdict`, `bus.ts`). A dropped `Stop` strands a pane at
`working` forever; a dropped `PreToolUse[AskUserQuestion]` never goes blocked.
Subagent events genuinely are concurrent, so this is not a rare interleaving. The
first draft's justification — "a lost increment is visible rather than harmful" —
was backwards: a lost increment produces a *duplicate*, and the duplicate is the
one verdict that is not delivered.

**`jq`.** The proposal was one `jq -cn` to build the envelope, fixing v1's
hand-rolled escaper (which missed newlines, making the event invalid JSON and so
silently dropped). But the escaper existed only because v1 **extracted fields in
bash**. v2 extracts nothing.

## Decision
**No `seq`.** The envelope omits it and `EventBus` numbers per source, keyed
`agent:<sessionId>` — already exactly per-session. Nothing can be dropped, and
ordering is arrival order.

**No `jq`.** Embedding an already-valid JSON document inside JSON is
concatenation, not parsing: three `printf`s around a verbatim splice (three, so a
large `AskUserQuestion` payload never becomes one oversized argv), with a
one-character validity guard falling back to `hook: null`. The only interpolated
values are the event name — a fixed string from `hooks.json` — and a UUID the
kernel minted, so nothing needs escaping.

`report.sh` stays **bash**: ADR 0004 measured `python3`'s ~50ms of startup putting
`PreToolUse` behind `Stop` and flipping the state, and node's ~40ms would do the
same.

## Consequences
- **`jq` is not on stock macOS** (`/opt/homebrew/bin/jq`; `curl` is `/usr/bin`),
  so the plugin now works with no Homebrew and needs no lossy fallback — v1's
  `grep`/`sed` path, which is what actually lost newlines.
- It restores ADR 0004's real invariant — **zero JSON parsing and zero
  subprocesses** on the common path — by removing the tool rather than by
  remembering not to use it. The review records that the invariant had already
  crept back once `jq` became survivable.
- Verified against a real unix-socket HTTP listener with payloads carrying
  newlines, escaped quotes, backslashes and multi-byte unicode: the document
  arrives byte-intact. Empty and malformed stdin degrade to `hook: null` and
  still send the event, because state is decided by the event **name** — a lost
  payload costs a cosmetic reason string, a lost event strands a pane.
- **What is given up:** hook-side ordering detection. A hook lost in transit (a
  `curl --max-time` expiry) is now invisible rather than showing as a gap. That is
  the correct trade — a diagnostic is worth less than the events it was dropping
  — and the cheap fix, if it is ever needed, is to make `duplicate` a
  deliver-and-warn for `agent` sources rather than to reintroduce the counter.
- A hostile payload cannot spoof the envelope: `session_id` is written **before**
  the splice, so a document that escapes its position can at worst add keys
  *inside* `payload`, and anything that does not still parse is answered with a
  logged 400.
