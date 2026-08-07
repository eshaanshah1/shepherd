# 0023. (v2) Permissions are granted once and checked always, and the store is the only gate

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only.

## Context
An ADE runs agents with shell access, so the bar for "what may this extension do"
is higher than a note-taking app's. Two models were on the table (sketch §8.2):
Obsidian's **trust-on-install** (you vetted the plugin, it can do anything) and
VS Code's *absence* of one (extensions are unsandboxed; the marketplace is the
control point). Neither is right here: the first gives no vocabulary for
consequences, and the second makes the marketplace load-bearing before one exists.

There is also a v1 lesson that shapes this more than either precedent. The
architecture review's §Bad-3 found authorization on the **read** side only: a
device that could see a workspace could also mutate it, because three routing
paths each decided for themselves what a caller was allowed to do and none of them
checked writes. The fix was one attributed `Caller` on every invocation, checked
in the dispatcher. Extensions are simply a fourth caller kind entering the same
seam — which means the permission model's job is *not* to build a second
enforcement path, only to answer "what does this principal hold".

## Decision
**Review at install, grant once, check on every invocation.**

- A manifest declares `permissions: Permission[]` from a **closed, coarse set**
  (`sessions`, `process.exec`, `storage`, `secrets`, `views`, `layout`,
  `attention`, `network`, `agents`). Coarse on purpose: a permission a user cannot
  reason about at install time is one they will grant without reading, so these
  name *consequences* ("can run arbitrary programs") rather than API surfaces.
  `agents` is separate from `process.exec` because it spends the user's model
  budget, which is not a consequence "can run programs" prepares anyone for
  (sketch §7c).
- **No first-use interrupts.** The grant happens once, at install, with the whole
  list in front of the user. An update that asks for **more** re-prompts; one
  asking for the same or fewer does not. That decision is the pure
  `permissionDiff(granted, requested)`, whose `needsReview` is true **iff
  something was added**.
- **Enforcement is `authorize(caller, required, grants)` in the command
  dispatcher** — the same function, in the same place, that judges a device and an
  agent. An extension's permission grant and a phone's workspace entitlement are
  checked at one envelope. There is no second path, and adding one is the defect
  this ADR exists to prevent.

Three consequences that were decisions, not accidents:

**A built-in is pre-granted by WRITING to the store, not by being exempt.**
`PermissionStore.review()` grants a `builtin` everything it declares at install
time; activation and invocation then read the store like anybody else.
`isGranted`/`grantSet` know nothing about sources. So "built-ins are trusted" and
"there is one authorization path" are both true, and the property that falls out
is the one worth having: **`revoke` bites a built-in immediately.** A source-based
carve-out (`if (source === 'builtin') return allow`) would have been one line
shorter and would have made a revoked built-in un-deniable — a gate that reports
success. (Its next `review` re-grants it, deliberately: a built-in that stayed
denied across a relaunch would leave the app partly broken with no permission UI
in M1 to repair it.)

**A pending review leaves the OLD grant in place.** When an update asks for more,
the store keeps the narrower set it already had rather than writing the requested
one. Writing it would make the re-prompt cosmetic — the capability would be held
by the time anybody was asked.

**An update asking for FEWER narrows silently.** No prompt: keeping a capability
the manifest no longer declares leaves something that nothing declares and nothing
shows.

Cross-extension reach is a separate axis and is **declared, not discovered**: a
manifest lists `dependencies`, and `extensions.get(id)` resolves only those ids.
That is sketch §3's dependency table becoming enforceable, and it gives the host
somewhere to check a dependency is active before activating the dependent.

## Consequences
- **`network` is coarse to the point of bluntness.** It is "may reach the
  internet", with no host allowlist. A panel view that legitimately talks to one
  API is indistinguishable from one that exfiltrates. Narrowing it (per-origin, CSP
  on panel webviews) is the obvious first refinement and should be driven by a
  real extension, not guessed at now.
- **The permission set is API, and coarse sets are hard to split later.** Adding a
  permission is easy; splitting `process.exec` into `process.exec` + `git` would
  invalidate every installed manifest. That is the price of coarseness, accepted.
- **`api` ranges are declared and not yet enforced.** A manifest says
  `api: "^1.0.0"` and M1 validates only its *shape*; nothing compares it to the
  host's version. So an extension written against a future API fails at the call
  rather than at load, with a worse message. Range satisfaction is a small,
  known gap — implement it when the API first breaks compatibility.
- **There is no permission UI in M1**, so a `user` extension is effectively
  un-installable until one exists. Built-ins are pre-granted, which is exactly why
  §7's rule that built-ins must consume `proposed` APIs is the proving ground.
- Do **not** add a `source === 'builtin'` shortcut to `isGranted`, `grantSet`, or
  the activation gate. Do not check a permission anywhere except through
  `authorize`. If a new surface needs a capability check, give it a `Permission`
  and a command.

## Lesson
The temptation was to express "built-ins are trusted" as a branch at the point of
enforcement, because that is where the sentence sounds true. Expressing it instead
as a **write at install time** left one enforcement path and turned trust into
ordinary data — which is what made `revoke` work on a built-in without anybody
designing for it. When a rule about *who someone is* shows up next to a check
about *what they may do*, the rule is usually in the wrong place.
