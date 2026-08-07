# M3 probe evidence (2026-08-07)

The measurements behind
[`../../plans/2026-08-07-v2-m3-plan.md`](../../plans/2026-08-07-v2-m3-plan.md).
Committed because two of them **overturned decisions**, and the project's rule is
that a conclusion which overrides a normative instruction has to be reproducible —
not a claim in a plan.

| file | what it is |
|---|---|
| `probe-claude-evidence.txt` | ~20 headless `claude -p` sessions (Claude Code 2.1.224) against purpose-built task roots: what a generated `CLAUDE.md` / `.claude/` is and is not discovered. |
| `s2.sh` … `s11.sh`, `cfg.sh` | The worktree probe, run against git 2.50.1 (Apple Git-155) on APFS. `s2*` branch resolution, `s3` leftover directories, `s4*` removal, `s5*` reconstruction/repair, `s6*` the archive round trip, `s7` submodules, `s8` timing. |
| `real-claude-hook-payloads.jsonl` | Real hook envelopes from a live Claude session, recorded off the v2 event ingress — the evidence that `claude-code`'s reducer reads the fields Claude actually sends. |

## The two findings that changed decisions

**v1's branch resolution is silently wrong** (`s2.sh`). `branchExists` checks
`refs/heads/` only, so a branch that exists *only on origin* takes the
`-b <name> origin/<default>` path. git exits 0. The worktree holds the wrong
content under the right branch name with an upstream pointing elsewhere, and the
first symptom is a `git push` failing much later. Verified in v1's source at
`spike/seam1/Sources/WorktreeService.swift:74-77,115-117`. This is why the plan's
D12b rewrites the worktree layer's decisions rather than porting them, against the
Rebuild checklist's "port near-verbatim".

**The archive is better than assumed in one place and worse in three**
(`s6*.sh`). `git status --porcelain` before and after is byte-identical, **including
untracked files** — the gap everyone expects is not there. What is: gitignored files
are silently destroyed, a conflicted worktree cannot be archived at all
(`write-tree` hard-fails), and a detached worktree restores onto the archive commit.

## Running them

The scripts build their own throwaway fixtures under a scratch directory and touch
no real repository. They were run with `env -u NODE_OPTIONS`; the git behaviours
they measure are version-sensitive, so re-running them on a newer git is the point
rather than a formality.
