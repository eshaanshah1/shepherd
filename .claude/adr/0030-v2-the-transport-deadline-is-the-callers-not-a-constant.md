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
