import { describe, expect, it } from 'vitest';
import { extensionId, sessionId, type Caller, type Permission } from '@shepherd/sdk';
import { authorize, emptyGrants, type GrantSet } from './authorize.ts';

const TASKS = extensionId('shepherd.tasks');
const PHONE = 'pixel-9';
const AGENT = sessionId('s-1');

function grants(overrides: Partial<GrantSet> = {}): GrantSet {
  return { ...emptyGrants(), ...overrides };
}

const withTasks = (...permissions: Permission[]) =>
  grants({ extensions: new Map([[TASKS, permissions]]) });

describe('the user', () => {
  it('is allowed anything, permission or not', () => {
    // The human at the keyboard is the authority the whole model derives from.
    // A permission gate on the user would be a gate on the person granting.
    expect(authorize({ kind: 'user' }, undefined, emptyGrants()).allowed).toBe(true);
    expect(authorize({ kind: 'user' }, 'process.exec', emptyGrants()).allowed).toBe(true);
  });
});

describe('the kernel', () => {
  it('is allowed, because there is no principal to check against', () => {
    // Not a privilege level: core IS the thing doing the checking. What makes this
    // safe is that no transport can mint a `kernel` caller — `externalCallerSchema`
    // has no such variant — which its own test pins.
    expect(authorize({ kind: 'kernel' }, undefined, emptyGrants()).allowed).toBe(true);
    expect(authorize({ kind: 'kernel' }, 'process.exec', emptyGrants()).allowed).toBe(true);
  });
});

describe('an unknown principal', () => {
  it('is denied even for a command that needs no permission', () => {
    // Reaching the socket is not identity. An extension that is not loaded, a
    // device that is not paired, and a session id that is not live are all
    // claims — and the dispatcher is the one place to disbelieve them.
    const cases: Caller[] = [
      { kind: 'extension', id: extensionId('who.dis') },
      { kind: 'device', deviceId: 'not-paired' },
      { kind: 'agent', sessionId: sessionId('not-live') },
    ];
    for (const caller of cases) {
      const verdict = authorize(caller, undefined, emptyGrants());
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(/unknown|not registered/i);
    }
  });
});

describe('an extension', () => {
  it('may invoke a permissionless command once it is loaded', () => {
    expect(authorize({ kind: 'extension', id: TASKS }, undefined, withTasks()).allowed).toBe(true);
  });

  it('needs the exact permission the command declares', () => {
    const caller: Caller = { kind: 'extension', id: TASKS };
    expect(authorize(caller, 'sessions', withTasks('sessions')).allowed).toBe(true);
    expect(authorize(caller, 'process.exec', withTasks('sessions')).allowed).toBe(false);
  });

  it('says which permission was missing, and who wanted it', () => {
    // The message reaches a log line and an extension author's console; "denied"
    // alone sends them reading the dispatcher instead of their manifest.
    const verdict = authorize({ kind: 'extension', id: TASKS }, 'agents', withTasks('storage'));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('agents');
      expect(verdict.reason).toContain('shepherd.tasks');
    }
  });

  it('holding several permissions is checked against the right one', () => {
    const caller: Caller = { kind: 'extension', id: TASKS };
    const g = withTasks('storage', 'sessions', 'layout');
    expect(authorize(caller, 'layout', g).allowed).toBe(true);
    expect(authorize(caller, 'network', g).allowed).toBe(false);
  });
});

describe('a device', () => {
  it('is checked against its own entitlements, not an extension\'s', () => {
    const g = grants({
      devices: new Map([[PHONE, ['sessions'] as Permission[]]]),
      extensions: new Map([[TASKS, ['process.exec'] as Permission[]]]),
    });
    expect(authorize({ kind: 'device', deviceId: PHONE }, 'sessions', g).allowed).toBe(true);
    // The phone must not inherit reach from an unrelated extension being trusted.
    expect(authorize({ kind: 'device', deviceId: PHONE }, 'process.exec', g).allowed).toBe(false);
  });
});

describe('an agent', () => {
  it('is scoped by its own session id', () => {
    const g = grants({ agents: new Map([[AGENT, ['sessions'] as Permission[]]]) });
    expect(authorize({ kind: 'agent', sessionId: AGENT }, 'sessions', g).allowed).toBe(true);
    expect(authorize({ kind: 'agent', sessionId: sessionId('s-2') }, 'sessions', g).allowed).toBe(false);
  });

  it('cannot reach process.exec just by being an agent', () => {
    // An agent in a pane already has Bash. What it must not get for free is the
    // *app's* privileges — that is a different blast radius from its own shell.
    const g = grants({ agents: new Map([[AGENT, ['sessions'] as Permission[]]]) });
    expect(authorize({ kind: 'agent', sessionId: AGENT }, 'process.exec', g).allowed).toBe(false);
  });
});
