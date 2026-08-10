# 0030. (v2) The transport deadline is the caller's, not a constant

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
Every child→host call shared one flat deadline (`CHILD_CALL_TIMEOUT_MS = 15_000`),
so that a wedged host produces a timeout rather than a promise nobody settles.
Good reason, and shorter than things M3 legitimately runs: a `git fetch` against
a cold remote is seconds at best, and provisioning does one per repo.

Under a flat 15s the extension would be told its provisioning **failed** while
git was still working — and the worktree would then appear anyway. A false
failure with a real side effect is worse than either a failure or a success.

The M2 handoff read this as "so `exec` needs a job protocol, not a verb". It does
not, and the reason is in the API that was already declared:
`ExecOptions.timeoutMs` is **required**, so the caller has already stated how
long this particular call may take. The transport was overriding that with a
smaller number it knew nothing about.

## Decision
The deadline rides the **`call` frame** and is derived from what the caller
asked for, plus slack. Everything that names no deadline keeps the flat 15s —
the property the constant exists for, pinned by its own test.

Three details, each of which is the decision rather than a detail:

- **On the frame, not on `ApiCall`.** `s.object` rejects unknown keys, so putting
  it on the call union means editing all ten variants; the frame is one edit, and
  a transport property belongs on the transport.
- **`timeoutMs` PLUS slack.** Equal deadlines make the transport give up at the
  instant the host is killing the process, which reproduces the false-failure
  above one layer along.
- **The child gained `#failPending`.** Main has settled its outstanding calls on
  disconnect since M1; the child had only the timer. That was survivable while
  every call shared 15s and stops being survivable when a call may name ten
  minutes — a dead main process would mean a ten-minute hang. Its trigger already
  existed: `port.on('close')` was writing to stderr and telling nobody.

## Amendment (2026-08-10): the same rule, host→child

This decision was implemented for **child→host calls** only. The other direction
— main asking the child, `ExtensionHost.#ask` — kept a flat `ASK_TIMEOUT_MS` of
10s, and a command an extension owns is dispatched through exactly that ask. So
the decision above was half-applied, and the half that was missing broke the
first consumer that needed it.

`agents.complete` asks a model: **10–16s of network, measured** (five briefs
against `claude-haiku-4-5`). Every naming call over 10s was therefore answered
`timeout` by main while the child was still working, and the real answer arrived
to a caller that had stopped listening. The symptom was a task whose branch kept
the heuristic name while an identical task 90 seconds later got a model one —
a coin flip on which side of 10s that call landed. `NAME_ASK_TIMEOUT_MS = 30_000`
and `QUICK_TIMEOUT_MS = 30_000` were both unreachable, so the commit that raised
them ("the ask deadline is 30s, because a real naming call is 10.5s") changed
nothing.

The rule is now applied in both directions:

- `commands.invoke(id, args, { timeoutMs })` — the caller states its patience.
  `InvokeOptions` and `Invocation` are the SDK's two halves of it.
- It rides the **`command.invoke` call variant**, not the frame. The frame is
  right for a property of one transport; this one has to survive being forwarded
  into a *second* leg, and `deadlineFor` reads it from the call the way it already
  reads `process.exec`'s.
- `CommandRegistry` hands it to the handler rather than acting on it: the registry
  runs handlers in-process and has nothing to time out. A proxy handler does.
- **Two slacks on the outer leg, one on the inner.** The inner ask must fire
  first, or a callee's timeout is reported by the outer transport and reads as "the
  host is wedged".

Three of the four new tests fail with the change reverted (mutation-tested, for
the reason the last section of this ADR gives). The fourth is the guard on the
flat default, which must keep firing for anything that states nothing.

## Consequences
`ProcessAPI` lands promise-shaped, exactly as core-design §4.6 declares it. No
job protocol, no second way to run a program, and §7c's streaming half is
deferred on its own merits (M3 has no consumer for it) rather than because the
transport could not carry it.

The first test written for this **passed with the change reverted**: it used
`Promise.race` against an already-resolved sentinel, which the sentinel wins by
one microtask whether or not the call timed out, so it was measuring microtask
ordering. Caught by mutation-testing it. Rewritten against a settled flag with a
real macrotask flush, asserting both directions — still pending past the flat
default, settled at its own deadline.
