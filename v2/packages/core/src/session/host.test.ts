import { afterEach, describe, expect, it } from 'vitest';
import { isErr, isOk, sessionId, type SessionID } from '@shepherd/sdk';
import { SessionHost, foregroundReading, type SessionExit } from './host.ts';

// These run against a REAL /bin/sh pty. A faked spawn would prove the registry
// and nothing about the thing that actually breaks — node-pty's prebuild, its
// encoding, and the order its data and exit events arrive in.

const decoder = new TextDecoder();

let hosts: SessionHost[] = [];

function makeHost(...args: ConstructorParameters<typeof SessionHost>): SessionHost {
  const host = new SessionHost(...args);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

/** Polls rather than sleeps: a pty's first byte lands whenever it lands. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A collector that keeps the chunk boundaries — the ordering test needs them. */
function collector(): { chunks: Uint8Array[]; text: () => string; sink: (b: Uint8Array) => void } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    text: () => chunks.map((c) => decoder.decode(c)).join(''),
    sink: (bytes) => {
      chunks.push(bytes);
    },
  };
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('SessionHost lifecycle', () => {
  it('creates a session, streams its data, and captures its exit code', async () => {
    const host = makeHost();
    const out = collector();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'echo hello-from-pty; exit 7'],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const attached = host.attach(created.value.id, out.sink);
    expect(isOk(attached)).toBe(true);

    await waitFor(() => exits.length > 0, 'the session to exit');
    expect(out.text()).toContain('hello-from-pty');
    expect(exits).toHaveLength(1);
    expect(exits[0]?.exitCode).toBe(7);
    expect(exits[0]?.sessionId).toBe(created.value.id);
    expect(created.value.pid).toBeGreaterThan(0);
  });

  it('delivers bytes, not decoded strings', async () => {
    const host = makeHost();
    const out = collector();
    const done: SessionExit[] = [];
    host.onExit((e) => done.push(e));

    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      // A 3-byte UTF-8 sequence: proof the payload is raw and undecoded.
      args: ['-c', 'printf "\\342\\234\\223"'],
    });
    if (!isOk(created)) throw new Error('create failed');
    host.attach(created.value.id, out.sink);

    await waitFor(() => done.length > 0, 'exit');
    for (const chunk of out.chunks) expect(chunk).toBeInstanceOf(Uint8Array);
    const all = Buffer.concat(out.chunks.map((c) => Buffer.from(c)));
    expect([...all]).toContain(0xe2);
    expect(decoder.decode(all)).toContain('✓');
  });

  it('carries bytes that are not valid UTF-8 through unharmed', async () => {
    // This is what `encoding: null` buys. node-pty's default decodes to a
    // string, and 0xFF/0xFE are not valid UTF-8 — they come back as U+FFFD and
    // the original bytes are gone for good, before xterm (which owns the
    // decoder, and handles this correctly) ever sees them.
    const host = makeHost();
    const out = collector();
    const done: SessionExit[] = [];
    host.onExit((e) => done.push(e));

    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'printf "\\377\\376\\001"'],
    });
    if (!isOk(created)) throw new Error('create failed');
    host.attach(created.value.id, out.sink);

    await waitFor(() => done.length > 0, 'exit');
    const all = [...Buffer.concat(out.chunks.map((c) => Buffer.from(c)))];
    // `ESC c` leads, because attaching hands over a SNAPSHOT and a snapshot
    // replaces a screen rather than adding to one (`TerminalMirror.capture`).
    // Asserted rather than trimmed blindly: it is part of what a viewer is
    // handed, and the point of this test is that everything AFTER it is the
    // pty's bytes verbatim.
    expect(all.slice(0, 2)).toEqual([0x1b, 0x63]);
    expect(all.slice(2)).toEqual([0xff, 0xfe, 0x01]);
  });

  it('kill() fires onExit once and removes the id from list()', async () => {
    const host = makeHost();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'sleep 30'] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    expect(host.list().map((s) => s.id)).toContain(id);

    expect(isOk(host.kill(id))).toBe(true);
    await waitFor(() => exits.length > 0, 'the killed session to exit');

    // Killing twice must not produce a second exit — the second call cannot
    // find the session at all.
    const second = host.kill(id);
    expect(isErr(second)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exits).toHaveLength(1);
    expect(host.list().map((s) => s.id)).not.toContain(id);
  });

  it('get() on a dead id returns undefined and attach() returns a typed error', async () => {
    const host = makeHost();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'exit 0'] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    await waitFor(() => exits.length > 0, 'exit');

    expect(host.get(id)).toBeUndefined();
    expect(host.has(id)).toBe(false);

    // The whole point: a stale id from a renderer is a value, not an exception.
    let threw = false;
    let attached;
    try {
      attached = host.attach(id, () => {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(attached && isErr(attached)).toBe(true);
    if (attached && isErr(attached)) {
      expect(attached.error.code).toBe('unknown-session');
      expect(attached.error.sessionId).toBe(id);
    }

    for (const call of [
      host.write(id, 'x'),
      host.paste(id, 'x'),
      host.resize(id, 10, 10),
      host.kill(id),
    ]) {
      expect(isErr(call)).toBe(true);
    }
  });

  it('turns a throw out of node-pty into a typed error', () => {
    const host = makeHost();
    let threw = false;
    let created;
    try {
      // node-pty type-checks its options at runtime and throws. A renderer can
      // send anything over IPC, so the cast is the realistic shape of the bug.
      created = host.create({ cwd: '/tmp', command: '/bin/sh', term: 7 as unknown as string });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(created && isErr(created)).toBe(true);
    if (created && isErr(created)) expect(created.error.code).toBe('spawn-failed');
    expect(host.list()).toHaveLength(0);
  });

  it('a command that does not exist is an exit, not a spawn error (measured)', async () => {
    // Worth pinning because it is counter-intuitive: on darwin node-pty forks
    // first and execs in the child, so a missing binary and a bad cwd BOTH come
    // back as a normal `exitCode: 1` with no output — indistinguishable from a
    // program that started and failed. `create` therefore succeeds, and anyone
    // wanting "could not start" as a distinct outcome has to check the path
    // themselves before calling.
    const host = makeHost();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({ cwd: '/tmp', command: '/definitely/not/a/binary' });
    expect(isOk(created)).toBe(true);

    await waitFor(() => exits.length > 0, 'the failed exec to be reported as an exit');
    expect(exits[0]?.exitCode).toBe(1);
    expect(host.list()).toHaveLength(0);
  });

  it('rejects a nonsense spec before spawning anything', () => {
    const host = makeHost();
    const bad = host.create({ cwd: '/tmp', command: '/bin/sh', cols: 0 });
    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error.code).toBe('invalid-argument');
    expect(host.list()).toHaveLength(0);
  });

  it('errors on an id that never existed', () => {
    const host = makeHost();
    const nowhere = sessionId('never-minted') as SessionID;
    const attached = host.attach(nowhere, () => {});
    expect(isErr(attached)).toBe(true);
    if (isErr(attached)) expect(attached.error.code).toBe('unknown-session');
  });
});

describe('SessionHost attach ordering', () => {
  /**
   * The contract is PtyBroker's and unchanged — replay, then live, with no gap
   * and no duplicate. What R0 changed is both halves of "replay":
   *
   *   - it is a SCREEN, not the last 256 KB of stream, so it is asserted through
   *     `host.screen()` rather than by comparing byte-for-byte against a ring;
   *   - it arrives ASYNCHRONOUSLY, because the mirror captures at a point in its
   *     own write queue (see `mirror.ts`). `attach` still returns synchronously.
   */
  it('replays first, then continues live, with no duplication and no gap', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    // The markers are assembled by the shell so the ECHO of the command line
    // does not itself contain them — that is what makes "appears exactly once"
    // a real duplication check rather than an accident of terminal echo.
    host.write(id, "printf 'mark%s\\n' 'er-one'\n");
    await waitFor(
      () => (host.screen(id)?.text ?? '').includes('marker-one'),
      'marker-one to reach the screen',
    );

    const out = collector();
    const attached = host.attach(id, out.sink);
    expect(isOk(attached)).toBe(true);

    // The FIRST thing the sink sees is the replay — one chunk, carrying the
    // screen as it stood when attach was called.
    await waitFor(() => out.chunks.length > 0, 'the replay to arrive');
    expect(decoder.decode(out.chunks[0]!)).toContain('marker-one');

    host.write(id, "printf 'mark%s\\n' 'er-two'\n");
    await waitFor(() => out.text().includes('marker-two'), 'marker-two to reach the sink');

    const seen = out.text();
    expect(countOf(seen, 'marker-one')).toBe(1);
    expect(countOf(seen, 'marker-two')).toBe(1);
    expect(seen.indexOf('marker-one')).toBeLessThan(seen.indexOf('marker-two'));

    if (isOk(attached)) attached.value.dispose();
    host.write(id, "printf 'mark%s\\n' 'er-three'\n");
    await waitFor(
      () => (host.screen(id)?.text ?? '').includes('marker-three'),
      'marker-three to reach the screen after detach',
    );
    expect(out.text()).not.toContain('marker-three');
  });

  it('gives a second, later viewer the whole replay while the first keeps streaming', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    const first = collector();
    host.attach(id, first.sink);
    host.write(id, "printf 'alp%s\\n' 'ha-1'\n");
    await waitFor(() => first.text().includes('alpha-1'), 'alpha-1');

    const second = collector();
    host.attach(id, second.sink);
    await waitFor(() => second.text().includes('alpha-1'), "alpha-1 on the second viewer's replay");

    host.write(id, "printf 'bet%s\\n' 'a-2'\n");
    await waitFor(() => second.text().includes('beta-2'), 'beta-2 on the second viewer');
    await waitFor(() => first.text().includes('beta-2'), 'beta-2 on the first viewer');
    expect(countOf(second.text(), 'alpha-1')).toBe(1);
  });

  /** §4.1's third tier, which core-design defers to post-M4. It arrives free. */
  it('answers with the screen of a live session, and nothing for a dead one', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    host.write(id, "printf 'on-the-scr%s\\n' 'een'\n");
    await waitFor(
      () => (host.screen(id)?.text ?? '').includes('on-the-screen'),
      'the screen to catch up',
    );
    expect(host.screen(id)?.altScreen).toBe(false);
    expect(host.screen(sessionId('nope'))).toBeUndefined();
  });

  /** The one decision a remote viewer can force on a local pty. */
  it('sizes the pty to the SMALLEST attached viewport, and forgets a withdrawn one', () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [], cols: 80, rows: 24 });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    host.setViewport(id, 'mac', { cols: 200, rows: 50 });
    expect(host.get(id)).toMatchObject({ cols: 200, rows: 50 });

    // The phone is smaller, so it wins: letterboxing the Mac beats clipping it.
    host.setViewport(id, 'phone', { cols: 60, rows: 20 });
    expect(host.get(id)).toMatchObject({ cols: 60, rows: 20 });

    // …and when it goes away the Mac stops being letterboxed.
    host.setViewport(id, 'phone', undefined);
    expect(host.get(id)).toMatchObject({ cols: 200, rows: 50 });

    // A viewer with no opinion never influenced it in the first place.
    host.setViewport(id, 'extension-tap', undefined);
    expect(host.get(id)).toMatchObject({ cols: 200, rows: 50 });
  });
});

describe('SessionHost onWillCreate', () => {
  it('injects env that is observable in the child', async () => {
    const host = makeHost();
    const disposable = host.onWillCreate(() => ({ env: { SHEPHERD_TEST: '1' } }));

    const out = collector();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'echo "[$SHEPHERD_TEST]"'],
    });
    if (!isOk(created)) throw new Error('create failed');
    host.attach(created.value.id, out.sink);

    await waitFor(() => exits.length > 0, 'exit');
    expect(out.text()).toContain('[1]');
    disposable.dispose();
  });

  it('leaves the env alone when no hook is registered', async () => {
    const host = makeHost();
    const out = collector();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      // `env` is what the caller passed and nothing else: node-pty adds TERM
      // and PWD of its own accord (measured, unixTerminal.js), and no
      // SHEPHERD_* key exists unless a hook put one there.
      args: ['-c', 'echo "[$SHEPHERD_TEST][$MINE][$TERM]"'],
      env: { MINE: 'kept' },
      term: 'xterm-256color',
    });
    if (!isOk(created)) throw new Error('create failed');
    host.attach(created.value.id, out.sink);

    await waitFor(() => exits.length > 0, 'exit');
    expect(out.text()).toContain('[][kept][xterm-256color]');
  });

  it('merges hooks in registration order, last writer wins, and unregisters', async () => {
    const host = makeHost();
    host.onWillCreate(() => ({ env: { A: 'first', B: 'only-b' } }));
    const second = host.onWillCreate((e) => {
      // A hook sees the env earlier hooks already patched.
      expect(e.spec.env['A']).toBe('first');
      return { env: { A: 'second' } };
    });

    const run = async (): Promise<string> => {
      const out = collector();
      const exits: SessionExit[] = [];
      const off = host.onExit((e) => exits.push(e));
      const created = host.create({
        cwd: '/tmp',
        command: '/bin/sh',
        args: ['-c', 'echo "[$A][$B]"'],
      });
      if (!isOk(created)) throw new Error('create failed');
      host.attach(created.value.id, out.sink);
      await waitFor(() => exits.length > 0, 'exit');
      off.dispose();
      return out.text();
    };

    expect(await run()).toContain('[second][only-b]');
    second.dispose();
    expect(await run()).toContain('[first][only-b]');
  });

  it('a throwing hook is reported, skipped, and does not stop the session', async () => {
    const errors: string[] = [];
    const host = makeHost({ onError: (_e, context) => errors.push(context) });
    host.onWillCreate(() => {
      throw new Error('boom');
    });
    host.onWillCreate(() => ({ env: { SURVIVED: 'yes' } }));

    const out = collector();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'echo "[$SURVIVED]"'],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    host.attach(created.value.id, out.sink);

    await waitFor(() => exits.length > 0, 'exit');
    expect(out.text()).toContain('[yes]');
    expect(errors.some((c) => c.startsWith('onWillCreate hook'))).toBe(true);
  });
});

describe('SessionHost foreground process', () => {
  it('tracks the pty foreground across running a command and back', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/bash', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    // Waiting on the NAME, not on the predicate: for the first tick or two after
    // spawn the pty answers with the file we handed it, which already satisfies
    // "not busy" and would let this test pass before anything had settled.
    await waitFor(() => host.foregroundProcess(id) === 'bash', 'the shell to settle as the foreground');
    expect(host.hasForegroundProcess(id)).toBe(false);

    host.write(id, 'sleep 30\n');
    await waitFor(() => host.foregroundProcess(id) === 'sleep', 'sleep to take the foreground');
    expect(host.hasForegroundProcess(id)).toBe(true);

    // ^C, not waiting the sleep out: the pty's line discipline signals the
    // foreground group, so the transition back is the kernel's, not a timer's.
    host.write(id, '\x03');
    await waitFor(() => host.foregroundProcess(id) === 'bash', 'the shell to return to the foreground');
    expect(host.hasForegroundProcess(id)).toBe(false);
  });

  it('answers undefined / false for an id that is dead or never existed', async () => {
    const host = makeHost();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));

    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'exit 0'] });
    if (!isOk(created)) throw new Error('create failed');
    await waitFor(() => exits.length > 0, 'exit');

    // A dead pty runs nothing, so `false` is the truthful answer rather than a
    // hedge — and it must be an answer, not an exception, because the sweep
    // that asks this races every session's exit by construction.
    for (const id of [created.value.id, sessionId('never-minted') as SessionID]) {
      expect(host.foregroundProcess(id)).toBeUndefined();
      expect(host.hasForegroundProcess(id)).toBe(false);
    }
  });

  it('compares basenames, not paths', async () => {
    // The negative control for the predicate. The pty reports a bare name
    // (`bash`) and the spec carries a path (`/bin/bash`); an implementation
    // comparing those two verbatim calls every idle shell busy, and every other
    // assertion in this file still passes. Pinning both sides is what exposes it.
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/bash', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    await waitFor(() => host.foregroundProcess(id) === 'bash', 'the shell to settle');
    expect(host.get(id)?.command).toBe('/bin/bash');
    expect(host.hasForegroundProcess(id)).toBe(false);
  });

  it('inverts when the shell execs under another name (measured: /bin/sh is bash)', async () => {
    // Measured on macOS 26, and the one case where this predicate lies. `p_comm`
    // comes from the RESOLVED executable, and /bin/sh resolves to bash — so an
    // idle `/bin/sh` session reports `bash`, which is not `sh`, and reads busy
    // forever. Same root cause as a real `claude` reporting its version-named
    // binary; the answer is that a pane's session command must be the shell's
    // own path, and anything spawned through a wrapper is outside this predicate.
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    await waitFor(() => host.foregroundProcess(id) === 'bash', 'the sh session to report bash');
    expect(host.hasForegroundProcess(id)).toBe(true);
  });
});

describe('SessionHost input and geometry', () => {
  it('resize records the new grid and refuses nonsense', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', cols: 80, rows: 24 });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;

    expect(host.get(id)?.cols).toBe(80);
    expect(isOk(host.resize(id, 120, 40))).toBe(true);
    expect(host.get(id)?.cols).toBe(120);
    expect(host.get(id)?.rows).toBe(40);

    const bad = host.resize(id, 0, 40);
    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error.code).toBe('invalid-argument');
    expect(host.get(id)?.cols).toBe(120);

    // The child really sees it — `stty size` reports rows then cols.
    const out = collector();
    host.attach(id, out.sink);
    host.write(id, 'stty size\n');
    await waitFor(() => out.text().includes('40 120'), 'the child to report 40 120');
  });

  it('paste turns newlines into CR so a shell acts on each line', async () => {
    const host = makeHost();
    const created = host.create({ cwd: '/tmp', command: '/bin/sh', args: [] });
    if (!isOk(created)) throw new Error('create failed');
    const id = created.value.id;
    const out = collector();
    host.attach(id, out.sink);

    host.paste(id, "printf 'pas%s\\n' 'ted-a'\nprintf 'pas%s\\n' 'ted-b'\n");
    await waitFor(() => out.text().includes('pasted-b'), 'both pasted lines to run');
    expect(out.text()).toContain('pasted-a');
  });

  it('dispose() kills everything it owns', async () => {
    const host = new SessionHost();
    const exits: SessionExit[] = [];
    host.onExit((e) => exits.push(e));
    host.create({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'sleep 30'] });
    host.create({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'sleep 30'] });
    expect(host.list()).toHaveLength(2);

    host.dispose();
    expect(host.list()).toHaveLength(0);
    // Listeners are dropped by dispose(), so the count is the point, not the events.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe('foregroundReading — the pure decision', () => {
  it('reports an unreadable tty as "cannot tell", never as idle', () => {
    // THE case this shape exists for. `false` here is the reconciliation
    // sweep's demote signal, so answering it for a session whose tty merely
    // could not be read would mark a live, working agent as idle. node-pty
    // returns undefined rather than throwing on every darwin failure path, so
    // this is the real failure mode and not a defensive hypothetical.
    for (const raw of [undefined, '']) {
      expect(foregroundReading(raw, '/bin/zsh').hasForegroundProcess).toBeUndefined();
      expect(foregroundReading(raw, '/bin/zsh').name).toBeUndefined();
    }
  });

  it('is false when the session\'s own command is back in front', () => {
    expect(foregroundReading('zsh', '/bin/zsh')).toEqual({ name: 'zsh', hasForegroundProcess: false });
  });

  it('is true for anything else, whatever it is called', () => {
    // Name-blind on purpose: a real claude install resolves to a binary named
    // after its version, so a predicate that matched the vendor's name would
    // match nothing at all.
    for (const raw of ['sleep', '2.1.224', 'node', 'some-wrapper']) {
      expect(foregroundReading(raw, '/bin/zsh').hasForegroundProcess).toBe(true);
    }
  });

  it('compares basenames, because the two sides are a path and a bare name', () => {
    expect(foregroundReading('bash', '/bin/bash').hasForegroundProcess).toBe(false);
  });

  it('inverts when the shell execs under another name — the /bin/sh hazard', () => {
    // macOS derives the process name from the RESOLVED executable, so a session
    // spawned as `/bin/sh` reports `bash` and reads busy forever, and the sweep
    // would never demote a pane. A negative control on the constraint that a
    // pane must be spawned as the shell's own path.
    expect(foregroundReading('bash', '/bin/sh').hasForegroundProcess).toBe(true);
  });
});

describe('foreground — the IO shell over it', () => {
  it('reports a dead or unknown id as a real false, not as unknown', () => {
    // Distinct from an unreadable tty on purpose: there is nothing to reconcile
    // for a session that does not exist, so this is knowledge the sweep may act
    // on rather than an absence of it.
    const host = makeHost();
    expect(host.foreground(sessionId('nope')).hasForegroundProcess).toBe(false);
    expect(host.foreground(sessionId('nope')).name).toBeUndefined();
  });
});

describe('a session created with its screen already on it', () => {
  it('shows the seeded screen to the first viewer, before the pty says anything', async () => {
    // What a restored pane is made of: the bytes belong to a pty that ended days
    // ago, and the mirror is the one thing that answers "what should someone
    // arriving now see".
    const host = makeHost();
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'sleep 5'],
      seed: new TextEncoder().encode('work from before\r\n'),
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const seen = await new Promise<string>((resolve) => {
      host.snapshot(created.value.id, (bytes) => resolve(new TextDecoder().decode(bytes)));
    });
    expect(seen).toContain('work from before');
  });

  it('keeps what the live pty says AFTER the seed', async () => {
    const host = makeHost();
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'echo live-output; sleep 5'],
      seed: new TextEncoder().encode('work from before\r\n'),
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    await new Promise((resolve) => setTimeout(resolve, 250));
    const seen = await new Promise<string>((resolve) => {
      host.snapshot(created.value.id, (bytes) => resolve(new TextDecoder().decode(bytes)));
    });
    expect(seen).toContain('work from before');
    expect(seen).toContain('live-output');
  });
});
