# shepherd.claude-code

The Claude Code adapter: hook protocol, session resume, and the lifecycle→state map v1 carried in StopPolicy.

**Not built yet — arrives in M2.** This directory exists so the boundary
lint, the workspace globs and the import rules are already pointed at it: when
the code lands, the rules it must obey are older than it is.

Imports allowed: `@shepherd/sdk` only (no electron, no node-pty, no OS APIs,
no `@shepherd/core`). See `v2/tooling/eslint/boundaries.js`.
