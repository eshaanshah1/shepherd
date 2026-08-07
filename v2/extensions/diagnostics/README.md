# shepherd.diagnostics

The built-in you invoke to find out whether the extension host is alive.

```sh
shepherd invoke diagnostics.ping          # facts, incl. the pid they were computed in
shepherd invoke diagnostics.probeDenied   # the permission gate, from the inside
```

It exists for three reasons, in order of how long each will matter:

1. **It is a real tool.** When an extension stops responding, three very
   different situations look identical from outside: the utility process died,
   it is up but never activated that extension, or everything is fine and the
   extension is just slow. `diagnostics.ping` distinguishes them — no answer,
   `unavailable`, or facts including `childPid`.
2. **It consumes `api.proposed`**, which §7 *requires* of a built-in. Everything
   in M1's API is proposed, and an unstable API with no caller is an unstable API
   nobody notices breaking.
3. **It proves the permission model by being refused.** Its manifest declares
   `storage` and nothing else; `diagnostics.probeDenied` calls `attention.set`
   anyway and reports the typed `denied` the dispatcher's one authorizer gives
   it. `manifest.test.ts` asserts it never gains the `attention` permission,
   because the day it does, that proof turns into a success and stops proving
   anything.

Imports allowed: `@shepherd/sdk` only (no electron, no node-pty, no OS APIs, no
`@shepherd/core`) — see `v2/tooling/eslint/boundaries.js`.
