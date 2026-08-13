# OSC title and cwd reach the layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pane's tab label follows the OSC title its program sets, and its cwd follows `cd`, for every pane — including tabs you are not looking at.

**Architecture:** `TerminalMirror` is a headless xterm in the daemon fed every byte of every session. It already parses OSC 0/2 and OSC 7 and throws the result away. This plan gives it two listeners, carries what they report along the exact route `onResize` already travels (fanout → host → protocol frame → session client → router), and ends in `LayoutStore.observe()` — a method written in M1 that has never had a caller. `displayTitle`, the renderer, the tab strip and the sidebar are untouched: they already do the right thing with a `title` that is no longer always empty.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), `@xterm/headless@6.0.0`, vitest, pnpm workspaces, Electron.

**Spec:** `docs/superpowers/specs/2026-08-13-osc-title-and-cwd-design.md`

## Global Constraints

- **Every command runs from `v2/` and takes `env -u NODE_OPTIONS`.** An ambient `NODE_OPTIONS` makes Electron exit 9 before running a line of our code, and the symptom is every check failing at once with no output explaining why.
- The gate for every task is `env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test`.
- **`v2/tooling/eslint/boundaries.js` IS the architecture diagram.** This plan adds no import that crosses a new boundary. If lint complains about one, stop and re-read the plan rather than widening the rule.
- **Core never touches the platform.** `packages/core` may not call `os.hostname()`, `os.homedir()`, or read `process.env`. The hostname is a *parameter*, exactly as `displayTitle(pane, home)` takes `home` as one.
- **`erasableSyntaxOnly` forbids TypeScript parameter properties** (`constructor(private readonly x)`). Declare fields and assign in the body — every file here already does.
- Comments follow the repo rule: the non-obvious *why*, never a narration of the change or a recap of the bug. One short line is the ceiling unless the reasoning is genuinely load-bearing.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/core/src/session/osc.ts` *(new)* | Pure: turn an OSC 7 payload into an acceptable local path, or nothing. | 1 |
| `packages/core/src/session/osc.test.ts` *(new)* | Its tests. | 1 |
| `packages/core/src/session/mirror.ts` | Report title (OSC 0/2) and cwd (OSC 7) off the headless terminal. | 2 |
| `packages/core/src/session/mirror.test.ts` | Its tests. | 2 |
| `packages/core/src/session/fanout.ts` | Passthrough of the mirror's reports. | 3 |
| `packages/core/src/session/host.ts` | `SessionObserved`, the listener set, and the `hostname` option. | 3 |
| `packages/core/src/session/index.ts`, `packages/core/src/index.ts` | Barrel exports. | 1, 3 |
| `packages/daemon/src/main.ts`, `packages/app/src/main/index.ts` | Supply `os.hostname()` to the host. | 3 |
| `packages/core/src/session/protocol.ts` | `RESPONSE.observed`. | 4 |
| `packages/core/src/session/server.ts` | Broadcast it — **ungated**, unlike `resized`. | 4 |
| `packages/app/src/main/session-client.ts` | Receive it; `onObserved`. | 4 |
| `packages/app/src/main/session-router.ts` | Forward local and member reports under one event. | 5 |
| `packages/app/src/main/session-bridge.ts` | `SessionHostLike.onObserved`. | 5 |
| `packages/core/src/layout/store.ts` | The no-op guard in `observe`. | 6 |
| `packages/app/src/main/index.ts` | Session id → pane id → `layout.observe`. | 7 |
| `packages/app/src/main/smoke-m3.ts`, `smoke-registry.ts` | The end-to-end gate. | 7 |

---

### Task 1: The pure OSC 7 parser

An OSC 7 payload is `file://<host><percent-encoded-path>`. Two things make it more than a `decodeURIComponent` call, and both are why this is its own file with its own tests:

- The **host must be checked**. An `ssh` session running *inside* the pane emits OSC 7 naming a directory on the far machine. Writing it would set a cwd that does not exist here, and because cwd is persisted, that pane would restore into nothing.
- The host may be written three ways for one machine: empty, the short name (`zsh`'s `$HOST`), or an FQDN (`os.hostname()` may add `.local`). Comparing the whole string rejects the machine you are sitting at, so the comparison is of the **first label, case-insensitively**.

**Files:**
- Create: `v2/packages/core/src/session/osc.ts`
- Create: `v2/packages/core/src/session/osc.test.ts`
- Modify: `v2/packages/core/src/session/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces: `cwdFromOsc7(payload: string, localHostname: string | undefined): string | undefined` — the decoded absolute path when the payload names this machine, `undefined` otherwise.

- [ ] **Step 1: Write the failing test**

Create `v2/packages/core/src/session/osc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cwdFromOsc7 } from './osc.ts';

describe('cwdFromOsc7', () => {
  it('reads a path off a payload with no host', () => {
    expect(cwdFromOsc7('file:///Users/me/code', undefined)).toBe('/Users/me/code');
  });

  it('percent-decodes the path', () => {
    expect(cwdFromOsc7('file:///Users/me/my%20code', undefined)).toBe('/Users/me/my code');
  });

  it('accepts our own host', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', 'mac-b')).toBe('/Users/me');
  });

  /**
   * `zsh`'s `$HOST` is the short name and `os.hostname()` may carry a domain.
   * Comparing whole strings rejects the machine the user is sitting at.
   */
  it('accepts our host however many labels either side spells', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', 'mac-b.local')).toBe('/Users/me');
    expect(cwdFromOsc7('file://mac-b.local/Users/me', 'mac-b')).toBe('/Users/me');
    expect(cwdFromOsc7('file://MAC-B/Users/me', 'mac-b')).toBe('/Users/me');
  });

  /** An `ssh` session inside the pane names a directory that is not here. */
  it('refuses another machine', () => {
    expect(cwdFromOsc7('file://build-box/srv/app', 'mac-b')).toBeUndefined();
  });

  it('refuses a host when we do not know our own name', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', undefined)).toBeUndefined();
  });

  it('refuses anything that is not a file URL', () => {
    expect(cwdFromOsc7('http://mac-b/Users/me', 'mac-b')).toBeUndefined();
    expect(cwdFromOsc7('/Users/me', 'mac-b')).toBeUndefined();
    expect(cwdFromOsc7('', 'mac-b')).toBeUndefined();
  });

  /** A relative path is not a cwd, and would resolve against whatever ran next. */
  it('refuses a path that is not absolute', () => {
    expect(cwdFromOsc7('file://', undefined)).toBeUndefined();
    expect(cwdFromOsc7('file://mac-b', 'mac-b')).toBeUndefined();
  });

  /** A malformed escape makes `decodeURIComponent` THROW. */
  it('refuses a broken percent escape instead of throwing', () => {
    expect(cwdFromOsc7('file:///Users/%ZZ', undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- osc
```

Expected: FAIL — `Failed to resolve import "./osc.ts"`.

- [ ] **Step 3: Write the implementation**

Create `v2/packages/core/src/session/osc.ts`:

```ts
/**
 * OSC 7 — `file://<host><percent-encoded-path>` — reduced to a path this machine
 * can actually open, or to nothing.
 *
 * Pure, and the hostname is a PARAMETER rather than an `os.hostname()` call:
 * core is process- and platform-agnostic, which is the same rule that keeps
 * `displayTitle` taking `home` instead of reading it.
 */

const FILE_SCHEME = 'file://';

/**
 * The path, when the payload names THIS machine. Otherwise nothing.
 *
 * The host check is not defensive tidiness. An `ssh` session running inside the
 * pane emits OSC 7 for the far machine, and a cwd is persisted — so accepting it
 * would make that pane restore into a directory that has never existed here.
 */
export function cwdFromOsc7(payload: string, localHostname: string | undefined): string | undefined {
  if (!payload.startsWith(FILE_SCHEME)) return undefined;
  const rest = payload.slice(FILE_SCHEME.length);
  const cut = rest.indexOf('/');
  if (cut < 0) return undefined;

  const host = rest.slice(0, cut);
  if (host !== '' && !sameMachine(host, localHostname)) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(rest.slice(cut));
  } catch {
    // A malformed escape THROWS rather than returning a partial string, and a
    // prompt is not worth taking a pty's parser down over.
    return undefined;
  }
  return path.startsWith('/') ? path : undefined;
}

/**
 * First label, case-insensitively — because one machine is spelled three ways.
 * `zsh` sends `$HOST` (short), `os.hostname()` may answer an FQDN, and a whole
 * string comparison therefore rejects the machine the user is sitting at.
 */
function sameMachine(host: string, localHostname: string | undefined): boolean {
  if (localHostname === undefined || localHostname === '') return false;
  return label(host) === label(localHostname);
}

function label(name: string): string {
  const dot = name.indexOf('.');
  return (dot < 0 ? name : name.slice(0, dot)).toLowerCase();
}
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- osc
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Export it**

In `v2/packages/core/src/session/index.ts`, add after the `./mirror.ts` export block:

```ts
export { cwdFromOsc7 } from './osc.ts';
```

- [ ] **Step 6: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 7: Commit**

```sh
git add v2/packages/core/src/session/osc.ts v2/packages/core/src/session/osc.test.ts v2/packages/core/src/session/index.ts
git commit -m "$(cat <<'EOF'
feat(v2): an OSC 7 payload from another machine is not a cwd

A pane's cwd is persisted, so a `file://` URL an ssh session inside the
pane emitted would make that pane restore into a directory that has never
existed here. The host is checked by first label because one machine is
spelled three ways: empty, zsh's short $HOST, and an FQDN from
os.hostname().

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `TerminalMirror` reports title and cwd

The mirror is a real xterm and already parses both sequences. This subscribes to what it learns.

**Two things to get right:**

1. **xterm parses asynchronously.** Feeding bytes and asserting on the next line races the parser. `capture()` is the write barrier — its callback fires at that point in the write queue — so every test awaits `captured(mirror)` after feeding.
2. **Dedupe at the source.** oh-my-zsh re-emits the same cwd on every prompt. Suppressing an unchanged value here means the frame never crosses the socket, which is cheaper than every layer downstream deciding to ignore it.

**Files:**
- Modify: `v2/packages/core/src/session/mirror.ts`
- Modify: `v2/packages/core/src/session/mirror.test.ts`

**Interfaces:**
- Consumes: `cwdFromOsc7(payload, localHostname)` from Task 1.
- Produces:
  - `interface ObservedPatch { readonly title?: string; readonly cwd?: string }` (exported from `mirror.ts`)
  - `TerminalMirrorOptions.hostname?: string`
  - `TerminalMirror.onObserved(listener: (patch: ObservedPatch) => void): Disposable`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('TerminalMirror', …)` block in `v2/packages/core/src/session/mirror.test.ts`:

```ts
  /** OSC 2 (window title). xterm fires `onTitleChange` for OSC 0 and 2. */
  it('reports an OSC 2 title', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;building'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'building' }]);
    mirror.dispose();
  });

  it('reports an OSC 7 cwd for this machine, decoded', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b.local' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']7;file://mac-b/Users/me/my%20code\\'));
    await captured(mirror);

    expect(seen).toEqual([{ cwd: '/Users/me/my code' }]);
    mirror.dispose();
  });

  it('says nothing about an OSC 7 from another machine', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']7;file://build-box/srv/app\\'));
    await captured(mirror);

    expect(seen).toEqual([]);
    mirror.dispose();
  });

  /**
   * oh-my-zsh re-emits the same cwd on every prompt. Suppressed HERE, so the
   * frame never crosses the socket rather than being ignored six layers along.
   */
  it('says nothing when a value repeats', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;same]2;same]2;other'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'same' }, { title: 'other' }]);
    mirror.dispose();
  });

  /**
   * A pty chunk boundary lands wherever it lands. xterm's parser holds state
   * across writes; this pins that we have not put a decode in front of it that
   * does not.
   */
  it('reads a sequence split across two feeds', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;spl'));
    mirror.feed(encode('it'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'split' }]);
    mirror.dispose();
  });

  it('stops reporting once disposed', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    const subscription = mirror.onObserved((patch) => seen.push(patch));

    subscription.dispose();
    mirror.feed(encode(']2;ignored'));
    await captured(mirror);

    expect(seen).toEqual([]);
    mirror.dispose();
  });
```

And extend the import at the top of the file:

```ts
import { TerminalMirror, type ObservedPatch } from './mirror.ts';
```

- [ ] **Step 2: Run them and watch them fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- mirror
```

Expected: FAIL — `mirror.onObserved is not a function`.

- [ ] **Step 3: Implement it**

In `v2/packages/core/src/session/mirror.ts`:

Add to the imports at the top of the file:

```ts
import { toDisposable, type Disposable } from '@shepherd/sdk';
import { cwdFromOsc7 } from './osc.ts';
```

Add after the `ScreenState` interface:

```ts
/** What the running program said about itself. Only the fields that changed. */
export interface ObservedPatch {
  readonly title?: string;
  readonly cwd?: string;
}
```

Add `hostname` to `TerminalMirrorOptions`:

```ts
export interface TerminalMirrorOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly scrollback?: number;
  /**
   * This machine's name, for the OSC 7 host check — a parameter and never an
   * `os.hostname()` call, because core does not touch the platform. Absent
   * means only a host-less OSC 7 is accepted.
   */
  readonly hostname?: string;
}
```

Add the fields beside the existing private fields:

```ts
  readonly #observed = new Set<(patch: ObservedPatch) => void>();
  readonly #hostname: string | undefined;
  #title = '';
  #cwd: string | undefined;
```

At the end of the constructor, after `this.#terminal.loadAddon(this.#serializer);`:

```ts
    this.#hostname = options.hostname;

    /*
     * Both are deduped here rather than downstream: oh-my-zsh re-emits an
     * unchanged title and cwd on every prompt, and a frame not sent is cheaper
     * than six layers each deciding to ignore one.
     */
    this.#terminal.onTitleChange((title) => {
      if (title === this.#title) return;
      this.#title = title;
      this.#announce({ title });
    });

    this.#terminal.parser.registerOscHandler(7, (payload) => {
      const cwd = cwdFromOsc7(payload, this.#hostname);
      if (cwd !== undefined && cwd !== this.#cwd) {
        this.#cwd = cwd;
        this.#announce({ cwd });
      }
      // Handled either way: an OSC 7 we refuse is still an OSC 7, and reporting
      // it unhandled only invites xterm to log it once per prompt.
      return true;
    });
```

Add the public subscription beside `screen()`:

```ts
  /** The running program named itself, or changed directory. */
  onObserved(listener: (patch: ObservedPatch) => void): Disposable {
    this.#observed.add(listener);
    return toDisposable(() => {
      this.#observed.delete(listener);
    });
  }
```

Add the private announcer just before `dispose()`:

```ts
  #announce(patch: ObservedPatch): void {
    // A copy: a listener may unsubscribe from inside its own callback, which is
    // what `PtyFanout` already does one layer up.
    for (const listener of [...this.#observed]) listener(patch);
  }
```

And clear the set in `dispose()`, after `this.#terminal.dispose();`:

```ts
    this.#observed.clear();
```

- [ ] **Step 4: Run them and watch them pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- mirror
```

Expected: PASS, including the six new tests.

- [ ] **Step 5: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```sh
git add v2/packages/core/src/session/mirror.ts v2/packages/core/src/session/mirror.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): the mirror says what the program called itself

It has parsed OSC 0/2 and OSC 7 since it was written and discarded both.
Deduped at the source because oh-my-zsh re-emits an unchanged title and
cwd on every prompt, and a frame not sent beats six layers each deciding
to ignore one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `PtyFanout` and `SessionHost` announce it

The fanout owns the mirror, and the host owns the fanout and the session id. This is where a patch becomes a `SessionObserved`.

**Files:**
- Modify: `v2/packages/core/src/session/fanout.ts`
- Modify: `v2/packages/core/src/session/host.ts`
- Modify: `v2/packages/core/src/session/host.test.ts`
- Modify: `v2/packages/core/src/session/index.ts`, `v2/packages/core/src/index.ts`
- Modify: `v2/packages/daemon/src/main.ts`, `v2/packages/app/src/main/index.ts`

**Interfaces:**
- Consumes: `ObservedPatch`, `TerminalMirror.onObserved`, `TerminalMirrorOptions.hostname` from Task 2.
- Produces:
  - `interface SessionObserved { readonly sessionId: SessionID; readonly title?: string; readonly cwd?: string }` (from `host.ts`)
  - `PtyFanout.onObserved(listener: (patch: ObservedPatch) => void): Disposable`
  - `SessionHost.onObserved(listener: (observed: SessionObserved) => void): Disposable`
  - `SessionHostOptions.hostname?: string`

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/core/src/session/host.test.ts`, inside the existing top-level `describe` for `SessionHost`. Adjust the session-creation call to match whatever helper the neighbouring tests use — read one first.

```ts
  it('announces the title a session sets', async () => {
    const host = new SessionHost({ hostname: 'mac-b' });
    const seen: SessionObserved[] = [];
    host.onObserved((observed) => seen.push(observed));

    const created = host.create({
      command: '/bin/sh',
      args: ['-c', `printf '\\033]2;named\\007'; sleep 5`],
      cwd: process.cwd(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await vi.waitFor(() => {
      expect(seen).toContainEqual({ sessionId: created.value.id, title: 'named' });
    });

    host.kill(created.value.id);
    host.dispose();
  });
```

Add `SessionObserved` to the `./host.ts` import at the top of that file, and `vi` to the `vitest` import if it is not already there.

- [ ] **Step 2: Run it and watch it fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- host
```

Expected: FAIL — `host.onObserved is not a function`.

- [ ] **Step 3: Add the fanout passthrough**

In `v2/packages/core/src/session/fanout.ts`, extend the import:

```ts
import { TerminalMirror, type ObservedPatch, type ScreenState } from './mirror.ts';
```

Add beside `screen()`:

```ts
  /**
   * The mirror's reading of what the program calls itself, passed through
   * untouched. The fanout does not know a session id; `SessionHost` attaches one.
   */
  onObserved(listener: (patch: ObservedPatch) => void): Disposable {
    return this.#mirror.onObserved(listener);
  }
```

- [ ] **Step 4: Add the host event**

In `v2/packages/core/src/session/host.ts`:

Extend the `./mirror.ts` import with `type ObservedPatch`.

Add after the `SessionResize` interface:

```ts
/** What a session's program said about itself — only the fields that changed. */
export interface SessionObserved {
  readonly sessionId: SessionID;
  readonly title?: string;
  readonly cwd?: string;
}
```

Add to `SessionHostOptions`:

```ts
  /**
   * This machine's name, for the OSC 7 host check. Passed down to every
   * session's mirror; core never reads it from the platform itself.
   */
  readonly hostname?: string;
```

Add the field beside `#resizeListeners`:

```ts
  readonly #observedListeners = new Set<(observed: SessionObserved) => void>();
  readonly #hostname: string | undefined;
```

Assign it in the constructor:

```ts
    this.#hostname = options.hostname;
```

In `create`, thread the hostname into the mirror:

```ts
      fanout: new PtyFanout(
        new TerminalMirror({
          cols: resolved.cols,
          rows: resolved.rows,
          scrollback: resolved.scrollback,
          ...(this.#hostname === undefined ? {} : { hostname: this.#hostname }),
        }),
      ),
```

And subscribe, immediately after the `pty.onData(...)` block in `create`:

```ts
    record.fanout.onObserved((patch) => {
      this.#announceObserved({ sessionId: id, ...patch });
    });
```

Add the public subscription beside `onResize`:

```ts
  /**
   * The program in a session named itself (OSC 0/2) or changed directory (OSC 7).
   *
   * Independent of who is attached, and that is the point: a tab nobody is
   * looking at is exactly the one whose label would otherwise go stale.
   */
  onObserved(listener: (observed: SessionObserved) => void): Disposable {
    this.#observedListeners.add(listener);
    return toDisposable(() => {
      this.#observedListeners.delete(listener);
    });
  }
```

And the announcer beside `#reap`:

```ts
  #announceObserved(observed: SessionObserved): void {
    for (const listener of [...this.#observedListeners]) {
      try {
        listener(observed);
      } catch (error) {
        this.#onError?.(error, `onObserved listener for ${observed.sessionId}`);
      }
    }
  }
```

Finally, clear the set wherever `#exitListeners.clear()` already happens in `dispose()`:

```ts
    this.#observedListeners.clear();
```

- [ ] **Step 5: Export the new names**

In `v2/packages/core/src/session/index.ts`, add `type ObservedPatch` to the `./mirror.ts` export block and `type SessionObserved` to the `./host.ts` one.

In `v2/packages/core/src/index.ts`, add `type ObservedPatch` and `type SessionObserved` to the session export block (beside `type ScreenState` and `type SessionResize`).

- [ ] **Step 6: Supply the hostname**

In `v2/packages/daemon/src/main.ts`, add `import { hostname } from 'node:os';` and change the host construction at line 103:

```ts
  const host = new SessionHost({
    hostname: hostname(),
    onError: (error, context) => daemon.warn(`${context}: ${String(error)}`),
  });
```

In `v2/packages/app/src/main/index.ts`, do the same to the in-process fallback at line 256. Import `hostname` from `node:os` (check whether the file already imports from `node:os` and extend that import rather than adding a second):

```ts
  : new SessionHost({
      hostname: hostname(),
      onError: (error, context) =>
        process.stderr.write(`[shepherd] session ${context}: ${String(error)}\n`),
    });
```

- [ ] **Step 7: Run the tests and watch them pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- host
```

Expected: PASS.

- [ ] **Step 8: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 9: Commit**

```sh
git add v2/packages/core/src/session/ v2/packages/core/src/index.ts v2/packages/daemon/src/main.ts v2/packages/app/src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(v2): SessionHost announces what a session called itself

The fanout passes the mirror's reading through and the host puts a
session id on it, which is the same division onExit and onResize already
keep. Independent of who is attached: a tab nobody is looking at is
exactly the one whose label would otherwise go stale.

The hostname arrives as an option because core does not read the
platform — the daemon and the in-process fallback each supply it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The frame crosses the daemon socket

**The one thing here that is not a copy of `resized`:** the resize broadcast is gated on `client.attachments.has(sessionId)`, because only a client painting that session needs to reshape. **`observed` must NOT be gated that way.** A suspended pane sets `wantStream = false` (`pane-sessions.ts:365`), which detaches main from that session in the daemon — so an attachment gate would drop exactly the background-tab titles this whole change exists to deliver. It is broadcast to every connected client; a client that does not care ignores a small JSON frame.

**Files:**
- Modify: `v2/packages/core/src/session/protocol.ts`
- Modify: `v2/packages/core/src/session/server.ts`
- Modify: `v2/packages/core/src/session/server.test.ts`
- Modify: `v2/packages/app/src/main/session-client.ts`

**Interfaces:**
- Consumes: `SessionObserved`, `SessionHost.onObserved` from Task 3.
- Produces:
  - `RESPONSE.observed = 70`
  - `SessionClient.onObserved(listener: (observed: SessionObserved) => void): Disposable`

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/core/src/session/server.test.ts`. Read a neighbouring test first and reuse its fake host and connection helpers — the shape below assumes a fake host exposing `emitObserved`, matching however the file already fakes `onExit`/`onResize`.

```ts
  /**
   * NOT gated on attachment, unlike `resized`.
   *
   * A suspended pane detaches, so an attachment gate would drop precisely the
   * background-tab titles this frame exists to carry.
   */
  it('sends observed to a client that is attached to nothing', () => {
    const { host, server, connection } = harness();
    const client = server.accept(connection);
    void client;

    host.emitObserved({ sessionId: sessionId('s1'), title: 'named' });

    const frames = connection.written.flatMap((chunk) => new FrameDecoder().feed(chunk).frames);
    expect(frames.some((f) => f.kind === RESPONSE.observed)).toBe(true);
    expect(frames.find((f) => f.kind === RESPONSE.observed)?.json).toEqual({
      sessionId: 's1',
      title: 'named',
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- server
```

Expected: FAIL — `RESPONSE.observed` is undefined.

- [ ] **Step 3: Add the frame kind**

In `v2/packages/core/src/session/protocol.ts`, add to the `RESPONSE` object after `resized: 69,`:

```ts
  /**
   * A session's program named itself or changed directory. A JSON frame:
   * `{ sessionId, title?, cwd? }`, carrying only what changed.
   *
   * **Broadcast to every client, unlike `resized`.** A resize matters only to
   * somebody painting, so it is gated on attachment. This is the opposite case:
   * a suspended pane detaches, and it is exactly that tab whose label would
   * otherwise freeze at whatever it said when you last looked at it.
   */
  observed: 70,
```

Leave `BYTE_KINDS` alone — this is a JSON frame.

- [ ] **Step 4: Broadcast it**

In `v2/packages/core/src/session/server.ts`, add a field beside `#hostResize`:

```ts
  readonly #hostObserved: Disposable;
```

and, in the constructor after the `#hostResize` assignment:

```ts
    // Every client, attached or not — see `RESPONSE.observed`.
    this.#hostObserved = this.#host.onObserved((observed) => {
      for (const client of this.#clients.values()) {
        this.#send(client, encodeJsonFrame(RESPONSE.observed, { ...observed }));
      }
    });
```

Dispose it wherever `#hostResize.dispose()` already happens.

- [ ] **Step 5: Receive it**

In `v2/packages/app/src/main/session-client.ts`:

Add `type SessionObserved` to the `@shepherd/core` type import.

Add the field beside `#resizeListeners`:

```ts
  readonly #observedListeners = new Set<(observed: SessionObserved) => void>();
```

Add a branch in the frame handler, immediately before the `RESPONSE.snapshot` branch:

```ts
    if (frame.kind === RESPONSE.observed) {
      const observed = frame.json as SessionObserved;
      for (const listener of [...this.#observedListeners]) {
        try {
          listener(observed);
        } catch (error) {
          this.#log.warn(`an onObserved listener threw: ${String(error)}`);
        }
      }
      return;
    }
```

Add the subscription beside `onResize`:

```ts
  /** A session's program named itself or changed directory. */
  onObserved(listener: (observed: SessionObserved) => void): Disposable {
    this.#observedListeners.add(listener);
    return toDisposable(() => {
      this.#observedListeners.delete(listener);
    });
  }
```

And clear it in `dispose()` beside `this.#exitListeners.clear();`:

```ts
    this.#observedListeners.clear();
```

- [ ] **Step 6: Run the tests and watch them pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- server
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-client
```

Expected: PASS.

- [ ] **Step 7: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 8: Commit**

```sh
git add v2/packages/core/src/session/protocol.ts v2/packages/core/src/session/server.ts v2/packages/core/src/session/server.test.ts v2/packages/app/src/main/session-client.ts
git commit -m "$(cat <<'EOF'
feat(v2): `observed` crosses the daemon socket ungated

`resized` is sent only to clients attached to that session, because only
somebody painting needs it. This is the opposite case: a suspended pane
detaches, so an attachment gate would drop exactly the background-tab
titles the frame exists to carry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The router forwards it, local and remote

`SessionHostLike` is what main programs against, so it gains the method. Three real implementers (`SessionHost`, `SessionClient`, `SessionRouter`) already have it after Tasks 3–4; **the test fakes do not, and typecheck will name each one.** The known ones are in `session-bridge.test.ts` (around line 132) and `session-router.test.ts`.

**Files:**
- Modify: `v2/packages/app/src/main/session-router.ts`
- Modify: `v2/packages/app/src/main/session-router.test.ts`
- Modify: `v2/packages/app/src/main/session-bridge.ts`
- Modify: `v2/packages/app/src/main/session-bridge.test.ts`

**Interfaces:**
- Consumes: `SessionObserved` (Task 3), `SessionClient.onObserved` (Task 4).
- Produces: `SessionHostLike.onObserved(listener: (observed: SessionObserved) => void): Disposable`, implemented by `SessionRouter`.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/app/src/main/session-router.test.ts`, following the shape of whatever test already covers `onResize` re-qualification:

```ts
  it('re-emits a member’s observation under the qualified id', async () => {
    const { router, member } = await connectedRouter('mac-b');

    const seen: SessionObserved[] = [];
    router.onObserved((observed) => seen.push(observed));

    member.emitObserved({ sessionId: sessionId('s1'), title: 'named' });

    expect(seen).toEqual([{ sessionId: 'mac-b∷s1', title: 'named' }]);
  });

  it('passes a local observation through unchanged', () => {
    const { router, local } = routerOverLocal();

    const seen: SessionObserved[] = [];
    router.onObserved((observed) => seen.push(observed));

    local.emitObserved({ sessionId: sessionId('s1'), cwd: '/w' });

    expect(seen).toEqual([{ sessionId: 's1', cwd: '/w' }]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-router
```

Expected: FAIL — `router.onObserved is not a function`.

- [ ] **Step 3: Widen `SessionHostLike`**

In `v2/packages/app/src/main/session-bridge.ts`, add `type SessionObserved` to the `@shepherd/core` type import and add to the interface, beside `onResize`:

```ts
  /**
   * A session's program named itself or changed directory. Not used by the
   * bridge — main subscribes to it to keep pane labels live — but it belongs on
   * the interface because main only ever holds a `SessionHostLike`.
   */
  onObserved(listener: (observed: SessionObserved) => void): Disposable;
```

- [ ] **Step 4: Implement it on the router**

In `v2/packages/app/src/main/session-router.ts`, add `type SessionObserved` to the `@shepherd/core` type import.

Add the field beside `#resizeListeners`:

```ts
  readonly #observedListeners = new Set<(observed: SessionObserved) => void>();
```

Add to the local subscriptions in the constructor:

```ts
      this.#local.onObserved((observed) => this.#announceObserved(observed)),
```

Add to the per-member re-emission in `#member`, after the `client.onResize(...)` block:

```ts
    client.onObserved((observed) => {
      this.#announceObserved({
        ...observed,
        sessionId: toSessionId(qualify(memberId, observed.sessionId)),
      });
    });
```

Add the public subscription beside `onResize`:

```ts
  onObserved(listener: (observed: SessionObserved) => void): Disposable {
    this.#observedListeners.add(listener);
    return toDisposable(() => this.#observedListeners.delete(listener));
  }
```

And the announcer beside `#announceResize`:

```ts
  #announceObserved(observed: SessionObserved): void {
    for (const listener of [...this.#observedListeners]) {
      try {
        listener(observed);
      } catch (error) {
        this.#log.warn(`an onObserved listener threw: ${String(error)}`);
      }
    }
  }
```

- [ ] **Step 5: Fix the fakes typecheck names**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck
```

It will fail on every fake `SessionHostLike` missing the method. For each named file, add the same shape the fake already uses for `onResize`. In `session-bridge.test.ts` that is:

```ts
  #observedListeners = new Set<(o: SessionObserved) => void>();
  onObserved(listener: (o: SessionObserved) => void) {
    this.#observedListeners.add(listener);
    return toDisposable(() => this.#observedListeners.delete(listener));
  }
  emitObserved(o: SessionObserved) {
    for (const listener of this.#observedListeners) listener(o);
  }
```

Repeat until typecheck is clean. Do not make the interface method optional to dodge this — an optional method lets a real implementer skip it silently.

- [ ] **Step 6: Run the tests and watch them pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-router
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/app test -- session-bridge
```

Expected: PASS.

- [ ] **Step 7: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 8: Commit**

```sh
git add v2/packages/app/src/main/session-router.ts v2/packages/app/src/main/session-router.test.ts v2/packages/app/src/main/session-bridge.ts v2/packages/app/src/main/session-bridge.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): the router carries an observation, qualified like every other

A member's session is re-emitted under its qualified id for the reason
onExit and onResize are: a pane bound to `mac-b∷x` hears about `mac-b∷x`
and not about a bare id it never knew.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `observe` stops rewriting a pane that did not change

`#editPane` → `#changed` → notify every listener *and* schedule a persist. Without a guard, every shell prompt pushes a full layout snapshot to the renderer (`layout-ipc.ts:184` is not debounced) and schedules a disk write, to say nothing changed.

**Files:**
- Modify: `v2/packages/core/src/layout/store.ts` (the `observe` method at line 799)
- Modify: `v2/packages/core/src/layout/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `observe(pane, patch)` keeps returning `Result<void, string>`; it simply does nothing when the patch is a no-op.

- [ ] **Step 1: Write the failing test**

Append to `v2/packages/core/src/layout/store.test.ts`, inside the same `describe` block that holds `restores cwd and userTitle, but not the live title` (line 357). `build()`, `paneId` and the deterministic `p1` id are all already in that file — the fixture below is the one that test uses, minus the KV.

```ts
  it('observes a title and a cwd onto the pane', () => {
    const store = build();
    store.open();

    expect(store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' }).ok).toBe(true);

    expect(store.pane(paneId('p1'))?.title).toBe('vim');
    expect(store.pane(paneId('p1'))?.cwd).toBe('/w/api');
  });

  /**
   * A shell re-emits its title and cwd on every prompt. Rewriting the pane for
   * an unchanged value pushes a full snapshot to the renderer and schedules a
   * write, to say nothing happened.
   */
  it('says nothing when an observation changes nothing', () => {
    const store = build();
    store.open();
    store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' });

    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });

    expect(store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' }).ok).toBe(true);
    expect(notifications).toBe(0);

    // …and a real change still gets through.
    store.observe(paneId('p1'), { title: 'zsh' });
    expect(notifications).toBe(1);
  });

  /** A partial patch leaves the other field alone rather than clearing it. */
  it('keeps the field an observation does not mention', () => {
    const store = build();
    store.open();
    store.observe(paneId('p1'), { title: 'vim', cwd: '/w/api' });

    store.observe(paneId('p1'), { title: 'zsh' });

    expect(store.pane(paneId('p1'))?.cwd).toBe('/w/api');
  });

  it('still refuses a pane it does not have', () => {
    const store = build();
    store.open();
    expect(store.observe(paneId('nope'), { title: 'x' }).ok).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- layout/store
```

Expected: FAIL on the second test — `notifications` is 1, not 0.

- [ ] **Step 3: Add the guard**

Replace `observe` in `v2/packages/core/src/layout/store.ts`:

```ts
  /**
   * The pty reported a new cwd or OSC title.
   *
   * A no-op patch returns without touching the tree: a shell re-emits both on
   * every prompt, and `#editPane` would push a full snapshot to the renderer
   * and schedule a write to say nothing had happened. The "no pane" refusal
   * still has to come first — a miss is not the same answer as a no-op.
   */
  observe(pane: PaneID, patch: { readonly title?: string; readonly cwd?: string }): Result<void, string> {
    const current = this.pane(pane);
    if (current === undefined) return err(`no pane ${pane}`);
    const title = patch.title ?? current.title;
    const cwd = patch.cwd ?? current.cwd;
    if (title === current.title && cwd === current.cwd) return ok(undefined);
    return this.#editPane(pane, (live) => ({ ...live, title, cwd }));
  }
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd v2 && env -u NODE_OPTIONS pnpm --filter @shepherd/core test -- layout/store
```

Expected: PASS.

- [ ] **Step 5: Run the full gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```sh
git add v2/packages/core/src/layout/store.ts v2/packages/core/src/layout/store.test.ts
git commit -m "$(cat <<'EOF'
fix(v2): an observation that changes nothing rewrites nothing

A shell re-emits its title and cwd on every prompt, and #editPane pushes
a full snapshot to the renderer and schedules a write. The "no pane"
refusal stays ahead of the guard: a miss is not a no-op.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Main writes it into the layout, and the smoke proves it

The last step, and the only one whose real test is the smoke. `index.ts` is the composition root — it holds `host` (a `SessionHostLike`) and `layout` (the `LayoutStore`) at module scope. `store.paneForSession` already exists. `layout-ipc.ts:184` already republishes on `onDidChange`, so the renderer follows for free.

**The smoke is the point of this task.** A green unit suite is not a working app and this repo has the scars: the archive-on-close bug passed every unit test because each supplied both halves of the correlation. The assertion below writes into a **background** tab's real pty and reads the label back through the real control socket.

**Files:**
- Modify: `v2/packages/app/src/main/index.ts`
- Modify: `v2/packages/app/src/main/smoke-m3.ts`
- Modify: `v2/packages/app/src/main/smoke-registry.ts`

**Interfaces:**
- Consumes: `SessionHostLike.onObserved` (Task 5), `LayoutStore.observe` (Task 6), `LayoutStore.paneForSession`.
- Produces: nothing further downstream.

- [ ] **Step 1: Wire main**

In `v2/packages/app/src/main/index.ts`, add immediately after the `const bridge = new SessionBridge(...)` block (which ends at line 652):

```ts
/**
 * A program's own name for its pane, and the directory it is sitting in.
 *
 * The mirror reports these whether or not anyone is attached, which is the
 * whole reason they are read here rather than in the renderer: a suspended pane
 * has no terminal, and it is exactly that tab whose label would otherwise
 * freeze. `observe` ignores a patch that changes nothing, and `layout-ipc`
 * republishes on `onDidChange`, so the renderer follows with no push from here.
 */
const observed = host.onObserved((patch) => {
  const pane = layout.paneForSession(patch.sessionId);
  if (pane === undefined) return;
  const written = layout.observe(pane, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
  });
  if (!written.ok) logger.warn('layout', `pane ${pane} kept its name: ${written.error}`);
});
```

Dispose it alongside `stopRootsAnnouncer` in the `will-quit` handler — find that handler and add `observed.dispose();`.

- [ ] **Step 2: Hand the smoke a host**

In `v2/packages/app/src/main/smoke-registry.ts`, change line 70 to pass `host` through, matching `runM1Smoke` and `runM2Smoke`:

```ts
      return runM3Smoke(win, host, kernel);
```

In `v2/packages/app/src/main/smoke-m3.ts`, change the signature at line 47 and add the import:

```ts
import type { SessionHostLike } from './session-bridge.ts';

export async function runM3Smoke(
  win: BrowserWindow,
  host: SessionHostLike,
  options: M3SmokeOptions,
): Promise<void> {
```

- [ ] **Step 3: Write the smoke assertion**

In `v2/packages/app/src/main/smoke-m3.ts`, insert immediately after line 755 (`say('ok — a hidden tab keeps its ptys');`). At that point `secondTab` is the active root and both tabs have live sessions.

```ts
  /**
   * --- the OSC title reaches a tab NOBODY is looking at.
   *
   * The reason this is here and not in a unit test: a suspended pane detaches
   * from its session, so every layer between the pty and the tab strip has to
   * carry this without an attachment. A test that fed a store directly would
   * pass with the whole transport missing, which is the shape that hid the
   * archive-on-close bug.
   *
   * Switched AWAY first, deliberately — the claim is about a background tab.
   */
  const secondSession = ((await invoke('layout.listRoots', { group: `task:${composed.id}` })) as {
    root: string;
    focusedSession: string | null;
  }[]).find((root) => root.root === secondTab)?.focusedSession;
  check(typeof secondSession === 'string', `the second tab has a session: ${String(secondSession)}`);

  await invoke('layout.switchRoot', { root: `task:${composed.id}` });

  const labelOf = async (root: string): Promise<string> =>
    ((await invoke('layout.listRoots', { group: `task:${composed.id}` })) as {
      root: string;
      label: string;
    }[]).find((each) => each.root === root)?.label ?? '';

  /*
   * Typed as INPUT: the shell runs it and the OSC arrives as output, which is
   * the same road a real program's title travels. A `sleep` first so the write
   * cannot land before the renderer has finished suspending the pane.
   */
  host.write(toSessionId(String(secondSession)), `printf '\\033]2;osc-smoke\\007'\n`);

  await until(
    "the background tab's label to follow its OSC title",
    () => labelOf(secondTab),
    (label) => label === 'osc-smoke',
  );
  say('ok — a background tab follows its OSC title');
```

Add `sessionId as toSessionId` to the `@shepherd/sdk` import at the top of `smoke-m3.ts` (add the import if the file has none).

- [ ] **Step 4: Run the unit gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
```

Expected: all green.

- [ ] **Step 5: Run the smoke — this is the real gate**

```sh
cd v2 && env -u NODE_OPTIONS pnpm smoke:m3
```

Expected: every existing check still passes, plus `ok — a background tab follows its OSC title`.

If the new check times out, read `~/.shepherd/v2-dev/daemon.log` first — the daemon owns every pty, so an app that is fine and a title that never arrives is its story to tell.

- [ ] **Step 6: Verify against the real app**

```sh
cd v2 && env -u NODE_OPTIONS pnpm ship --dev
```

Then in **Shep Night**: open a task, press ⌘⇧T for a second tab, and run something that sets a title (`vim`, or `printf '\033]2;hello\007'`). The tab label must follow it, and must keep following it while you sit on the other tab. Then `cd` somewhere and confirm a third tab opens in the new directory.

This step exists because the OSC 7 host check compares this machine's real hostname against what your shell really sends, and neither value appears in any test. If cwd never updates, that comparison is the first suspect — log the rejected payload once and read it.

- [ ] **Step 7: Commit**

```sh
git add v2/packages/app/src/main/index.ts v2/packages/app/src/main/smoke-m3.ts v2/packages/app/src/main/smoke-registry.ts
git commit -m "$(cat <<'EOF'
feat(v2): a pane's label follows the title its program sets

`LayoutStore.observe` was written in M1 and has had no caller since; this
is it. The smoke writes into a BACKGROUND tab's pty and reads the label
back through the control socket, because a unit test that fed the store
directly would pass with the entire transport missing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: the seam (2–5, 7), what the mirror reports (1–2), noise control (6), cwd tracking (1–2 for the parse, 7 for the live check), out-of-scope items deliberately untouched, and the four listed tests (1, 2, 4, 6, 7).

**Type consistency.** `ObservedPatch` is `{title?, cwd?}` throughout and is the mirror's and the fanout's currency; `SessionObserved` is that plus `sessionId` and is the host's and everything above it. `onObserved` is the method name at every layer. `cwdFromOsc7(payload, localHostname)` keeps that signature in Tasks 1 and 2. `hostname` is the option name on both `TerminalMirrorOptions` and `SessionHostOptions`.

**Placeholder scan.** Task 6's tests are now literal against that file's real `build()` / `paneId('p1')` fixture. Tasks 3, 4 and 5 still name a fake's method (`emitObserved`) rather than defining the fake, because each of those files already has one for `onExit`/`onResize` and the new method is one more of the same shape — Task 5 Step 5 spells that shape out in full. Every assertion in the plan is exact; nothing is deferred except which existing helper to hang it on.

**One correction to the spec.** It says `LayoutStore.observe` "has zero callers". Precisely: no caller in production code. `store.test.ts:361` calls it, which is why `restores cwd and userTitle, but not the live title` passes today — the test supplies the fact the app never produces. That is the same shape as the archive-on-close bug this repo records, and it is why Task 7's smoke, not a unit test, is this plan's gate.
