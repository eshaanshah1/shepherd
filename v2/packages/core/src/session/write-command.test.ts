import { describe, expect, it } from 'vitest';
import { createLogger, manualClock, extensionId, type Caller } from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants, type GrantSet } from '../commands/authorize.ts';
import { registerSessionCommands, SESSION_COMMANDS, type SessionInventory } from './commands.ts';

/**
 * `sessions.write` — the verb that lets an extension speak to a session that
 * already exists.
 *
 * Its absence was load-bearing in the wrong direction: `SessionHost.paste` has
 * existed since M0 with no way in from outside main, so an extension with
 * something to say to a running agent had to open a SECOND agent to say it.
 * `github`'s "Hand to agent" is the caller that made that indefensible.
 *
 * A fake inventory here rather than a real pty, deliberately: the claim is about
 * WHICH CALLS the command makes and in what order — paste the body, then press
 * Enter as a separate write — and a real pty would prove that `cat` echoes.
 * `host.test.ts` owns the bracketing itself, against a real terminal.
 */

const USER: Caller = { kind: 'user' };
const EXT = extensionId('shepherd.github');
const EXT_CALLER: Caller = { kind: 'extension', id: EXT };

interface Recorded {
  readonly calls: string[];
  readonly registry: CommandRegistry;
}

function build(options: { grants?: GrantSet; failPaste?: boolean } = {}): Recorded {
  const calls: string[] = [];
  const host: SessionInventory = {
    list: () => [],
    foreground: () => ({ hasForegroundProcess: false }),
    snapshot: () => ({ ok: true }),
    paste: (_id, text) => {
      if (options.failPaste === true) return { ok: false, error: { message: 'no such session' } };
      calls.push(`paste:${text}`);
      return { ok: true };
    },
    write: (_id, data) => {
      calls.push(`write:${String(data)}`);
      return { ok: true };
    },
  };
  const registry = new CommandRegistry({
    logger: createLogger({ clock: manualClock(0), level: 'debug', sink: () => {} }),
    grants: () => options.grants ?? emptyGrants(),
  });
  registerSessionCommands({ host, registry });
  return { calls, registry };
}

describe('sessions.write', () => {
  it('needs the sessions permission', async () => {
    const { registry } = build({ grants: { ...emptyGrants(), extensions: new Map([[EXT, []]]) } });
    const answer = await registry.invoke(SESSION_COMMANDS.write, { session: 's', text: 'hi' }, EXT_CALLER);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe('denied');
  });

  it('is reachable by an extension that has it', async () => {
    const { registry, calls } = build({
      grants: { ...emptyGrants(), extensions: new Map([[EXT, ['sessions']]]) },
    });
    const answer = await registry.invoke(SESSION_COMMANDS.write, { session: 's', text: 'hi' }, EXT_CALLER);
    expect(answer.ok).toBe(true);
    expect(calls).toEqual(['paste:hi']);
  });

  it('PASTES rather than types, which is what makes multi-line text survive', async () => {
    // A typed newline is an Enter press. `paste` is where the bracketing
    // decision lives, and routing through it is the whole point of the verb.
    const { registry, calls } = build();
    await registry.invoke(SESSION_COMMANDS.write, { session: 's', text: 'one\ntwo' }, USER);
    expect(calls).toEqual(['paste:one\ntwo']);
  });

  it('does not press Enter unless asked', async () => {
    // Filling a prompt and sending it are two decisions; a verb that always sent
    // could not hand somebody a draft.
    const { registry, calls } = build();
    await registry.invoke(SESSION_COMMANDS.write, { session: 's', text: 'hi' }, USER);
    expect(calls).toEqual(['paste:hi']);

    const answer = await registry.invoke(SESSION_COMMANDS.write, { session: 's', text: 'hi', submit: true }, USER);
    // AFTER the paste, and as its own write: a CR inside the brackets is part of
    // the pasted text, not a key press.
    expect(calls).toEqual(['paste:hi', 'paste:hi', 'write:\r']);
    expect(answer.ok && (answer.value as { submitted: boolean }).submitted).toBe(true);
  });

  it('refuses a session that is not there rather than dropping the text', async () => {
    const { registry } = build({ failPaste: true });
    const answer = await registry.invoke(SESSION_COMMANDS.write, { session: 'ghost', text: 'hi' }, USER);
    expect(answer.ok).toBe(false);
  });

  it('is not in the palette — it takes a session id and a body of text', async () => {
    const { registry } = build();
    expect(registry.list().find((command) => command.id === SESSION_COMMANDS.write)?.title).toBeUndefined();
  });
});
