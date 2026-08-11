import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  isOk,
  manualClock,
  paneId,
  type Caller,
  type PaneID,
} from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants, type GrantSet } from '../commands/authorize.ts';
import { SessionHost } from './host.ts';
import { registerSessionCommands, SESSION_COMMANDS } from './commands.ts';

// A real pty again, for the same reason host.test.ts uses one: the interesting
// fields of the answer (`foregroundProcess`, `hasForegroundProcess`) come from
// the OS, and a stubbed host would assert only that this file copies properties.

const USER: Caller = { kind: 'user' };
const AGENTS = extensionId('shepherd.agents-core');
const AGENTS_CALLER: Caller = { kind: 'extension', id: AGENTS };

let hosts: SessionHost[] = [];

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

function build(grants: GrantSet = emptyGrants()) {
  const host = new SessionHost();
  hosts.push(host);
  const registry = new CommandRegistry({
    logger: createLogger({ clock: manualClock(0), level: 'debug', sink: () => {} }),
    grants: () => grants,
  });
  const subscription = registerSessionCommands({ host, registry });
  return { host, registry, subscription };
}

function grantsFor(permissions: readonly ('sessions' | 'attention')[]): GrantSet {
  return { ...emptyGrants(), extensions: new Map([[AGENTS, permissions]]) };
}

interface ListedSession {
  readonly id: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly paneId?: PaneID;
  readonly foregroundProcess?: string;
  readonly hasForegroundProcess: boolean;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('sessions.list', () => {
  it('answers every live session with its geometry and its foreground', async () => {
    const { host, registry } = build();
    const pane = paneId('pane-7');
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/bash',
      args: [],
      cols: 100,
      rows: 30,
      paneId: pane,
    });
    if (!isOk(created)) throw new Error('create failed');

    await waitFor(() => host.foregroundProcess(created.value.id) === 'bash', 'the shell to settle');

    const result = await registry.invoke<ListedSession[]>(SESSION_COMMANDS.list, undefined, USER);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value).toHaveLength(1);
    const only = result.value[0]!;
    expect(only).toMatchObject({
      id: created.value.id,
      cwd: '/tmp',
      command: '/bin/bash',
      args: [],
      cols: 100,
      rows: 30,
      paneId: pane,
      foregroundProcess: 'bash',
      hasForegroundProcess: false,
    });
  });

  it('reports a session as busy while something runs in it', async () => {
    const { host, registry } = build();
    const created = host.create({ cwd: '/tmp', command: '/bin/bash', args: [] });
    if (!isOk(created)) throw new Error('create failed');

    host.write(created.value.id, 'sleep 30\n');
    // On the name, not the predicate: a shell runs transient helpers of its own
    // while starting up, so "busy" goes true before `sleep` is anywhere near the
    // foreground and this would then list a settled, idle shell.
    await waitFor(() => host.foregroundProcess(created.value.id) === 'sleep', 'sleep to take the foreground');

    const result = await registry.invoke<ListedSession[]>(SESSION_COMMANDS.list, undefined, USER);
    if (!isOk(result)) throw new Error('list failed');
    expect(result.value[0]).toMatchObject({ foregroundProcess: 'sleep', hasForegroundProcess: true });
  });

  it('answers an empty array when nothing is running', async () => {
    const { registry } = build();
    const result = await registry.invoke<ListedSession[]>(SESSION_COMMANDS.list, undefined, USER);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('refuses a caller that lacks the sessions permission', async () => {
    const { registry } = build(grantsFor(['attention']));
    const result = await registry.invoke(SESSION_COMMANDS.list, undefined, AGENTS_CALLER);

    // `denied` specifically, not merely `ok: false` — a typo in the command id
    // also fails, as `unknown-command`, so the weaker assertion would pass
    // against a command that was never registered at all.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('denied');
    expect(result.error.message).toContain('sessions');
  });

  it('allows an extension that holds the permission', async () => {
    const { registry } = build(grantsFor(['sessions']));
    const result = await registry.invoke(SESSION_COMMANDS.list, undefined, AGENTS_CALLER);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('unregisters on dispose', async () => {
    const { registry, subscription } = build();
    expect(registry.has(SESSION_COMMANDS.list)).toBe(true);
    subscription.dispose();
    expect(registry.has(SESSION_COMMANDS.list)).toBe(false);
    const result = await registry.invoke(SESSION_COMMANDS.list, undefined, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-command');
  });
});

describe('sessions.capture', () => {
  it('answers with the session’s screen as bytes', async () => {
    // The same read a late viewer gets on attach, for a caller that will have to
    // show this screen later having never seen it live.
    const { host, registry } = build();
    // A session that STAYS: the host reaps an exited one, and capturing a screen
    // is a question about a session that is still there.
    const created = host.create({
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'echo archived-me; sleep 5'],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    // Give the pty a moment to write and the mirror to parse it.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const result = await registry.invoke(
      SESSION_COMMANDS.capture,
      { session: String(created.value.id) },
      USER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bytes } = result.value as { bytes: string };
    expect(Buffer.from(bytes, 'base64').toString('utf8')).toContain('archived-me');
  });

  it('refuses a session that is not there, rather than answering empty', async () => {
    // An empty screen and a missing session are different facts, and a caller
    // archiving a pane has to be able to tell them apart.
    const { registry } = build();
    const result = await registry.invoke(SESSION_COMMANDS.capture, { session: 'ghost' }, USER);
    expect(result.ok).toBe(false);
  });
});
