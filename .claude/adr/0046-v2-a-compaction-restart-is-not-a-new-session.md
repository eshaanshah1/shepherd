# 0046. A compaction restart is not a new session

Status: Accepted
Date: 2026-08-17

## Context
`applyEvent` had no case for `PreCompact` or `PostCompact`, and the plugin's
`hooks.json` did not subscribe to either — so compaction, the one thing an agent
does that takes minutes and changes the conversation underneath itself, had an
accident rather than a decision in the lifecycle map.

[Issue #3](https://github.com/eshaanshah1/shepherd/issues/3) raised two hypotheses
about what that accident cost, both drawn from [stablyai/orca](https://github.com/stablyai/orca)
as prior art. Both were measured against a real compacting session — a throwaway
project, a hook that logs every event with its payload, and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000` to force auto-compaction — and both are
**false on Claude Code v2.1.233**:

- **No `Stop` fires between `PreCompact` and `PostCompact`.** Compaction never
  looks like a finished turn, so it never produced a false "done".
- **No `UserPromptSubmit` follows `PostCompact`.** The
  `This session is being continued from a previous conversation…` record is
  written to the transcript with `isCompactSummary: true`, but it is not a
  hook-visible user prompt. Orca's continuation-prompt guard has no equivalent
  problem to solve here.

The measurement found a third thing instead, which neither the issue nor Orca
anticipated. **Auto-compaction fires a real `SessionStart`, mid-turn**, carrying
`source: "compact"`. Recorded from one interactive run that compacted three times:

```
UserPromptSubmit → PreToolUse/PostToolUse …
  PreCompact   {trigger: auto}
  SubagentStop                      ← the summarizer is a subagent
  SessionStart {source: "compact"}
  PostCompact  {trigger: auto}
→ PreToolUse/PostToolUse … → Stop
```

`SessionStart` is the second event that escapes the ordering guard
([ADR 0004](0004-plugin-protocol-and-ordering.md)) — it lands `idle` and clears
the title from any state. Replaying that recorded sequence through the real
`applyEvent` showed the cost is worse than either hypothesis:

```
PostToolUse    -> working   applied=true
SessionStart   -> idle      applied=true clearTitle=true   ← flips mid-turn
PreToolUse     -> idle      applied=false
SessionStart   -> idle      applied=true clearTitle=true
PostToolUse    -> idle      applied=false
Stop           -> idle      applied=false                  ← ignored
```

Once the pane reads `idle` the guard turns against us: every remaining event that
turn is not mid-turn, so it is discarded — **including the `Stop` that ends the
turn**. The dot says done while the agent keeps working, the agent's title is
wiped, and when the turn genuinely ends there is no `needsCheck` and no
notification. Nothing corrects it short of the user typing: the sweep detects
"claude exited", not "the turn ended", and is explicitly not a corrector.

This is not rare. It happens on every auto-compaction.

## Decision
A `SessionStart` whose `source` is `compact` **writes nothing** — it returns the
ordering guard's `applied: false`, preserving state, reason and title. Every other
source behaves exactly as before.

`source` reaches `applyEvent` as its **own typed field** (`sessionSource`), not as
a row in `DETAIL_FIELD`. `detail` is the cosmetic name for events that have one,
and the review's §Ugly-4 objection to one field with two jobs is the reason
`backgroundTasks` is a field; `source` decides a branch, so it gets the same
treatment.

`PreCompact` and `PostCompact` stay **unsubscribed**. They are not needed for
correctness, and two more hook subscriptions is two more shell invocations per
compaction. Compaction is now modelled — by the event that actually carries the
hazard.

### Why not re-assert `working` instead
Re-asserting `working` from any state is tempting: it would self-heal a pane whose
state had drifted for some other reason. It is rejected because `SessionStart`
carries `source` but no `trigger`, so it cannot tell an auto-compaction (always
mid-turn, always followed by a `Stop`) from a manual `/compact` (between turns, no
`Stop` follows). Forcing `working` on the manual path would build exactly the
spinning-forever agent that issue #3's second hypothesis turned out not to have.
Interactive manual `/compact` was measured emitting `PreCompact {trigger: manual}`
and no `SessionStart {source: compact}` at all — but "not observed" is not "cannot
happen", and `ignore()` is correct under every sequence recorded.

## Consequences
- **Fail-safe in the same direction as `backgroundTaskCount`.** An unknown source,
  or a plugin too old to send one, still lands `idle`. The failure mode of
  guessing wrong here is one stale "done" that the next `UserPromptSubmit`
  corrects — never a pane stuck `working` with no way out.
- **An unadopted pane is no longer adopted by a compaction.** `registry.reduce`
  treats `applied: false` as not-a-state-write and does not adopt, so a pane
  Shepherd has not adopted yet — the daemon restarted under a live `claude` —
  waits for the next `UserPromptSubmit` instead of being adopted by the compact
  `SessionStart`. Accepted: it would have been adopted as `idle`, which is wrong,
  and not-adopted beats adopted-and-lying. `index.ts`'s restore path already
  covers that pane.
- **The ownership lock is untouched.** It runs in `kind.ts` before `applyEvent`
  and re-sets the same Claude session id on a compact `SessionStart` — idempotent,
  and the resume target is still correct.
- Covered in `stop-policy.test.ts`, including a replay of the recorded interactive
  sequence that must reach `needsCheck` with `turnFinished: true`, and in
  `kind.test.ts` for `source` reaching the policy at all.
- **Concern 3 of issue #3 is still open** and is the general answer: nothing in
  Shepherd corrects a state that never resolves. A staleness floor bounds every
  unresolved state at once, where this ADR fixes one cause. This is now a measured
  instance of why that is worth having.

## Lesson
Both hypotheses in the issue were reasoned from another project's source and both
were wrong; the real bug was two hook events away from either of them and turned
up in the first log. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` makes forcing a
mid-turn compaction a two-minute experiment. When the question is what a vendor's
hooks actually do, record them.
