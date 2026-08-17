import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  extensionId,
  manualClock,
  nullLogger,
  PointRegistry,
  toDisposable,
  type CommandAPI,
  type CommandSpec,
  type EventAPI,
  type ExtensionContext,
  type KV,
  type ManualClock,
  type Schema,
  type Shepherd,
} from '@shepherd/sdk';
import type { TranscriptSearchProvider } from '@shepherd/ext-tasks/manifest';
import { activate, TRANSCRIPT_COMMANDS } from './index.ts';
import { TRANSCRIPT_SEARCH_POINT_ID } from './manifest.ts';
import type { ParsedSession } from './parse/session.ts';
import type { UsageRollup } from './model/usage.ts';

/**
 * Activated against a REAL directory.
 *
 * `activate` composes its own paths from `ctx.homeDir` and reads them with
 * `node:fs`, which is the behaviour worth testing — there is no seam to inject a
 * fake disk through, and inventing one only to satisfy a test would put a
 * parameter in the extension that the app never uses.
 *
 * Tail *semantics* are not tested here: they depend on `fs.watch` firing, which
 * is asynchronous and platform-timed. `watch.test.ts` covers them against a fake
 * disk and a hand-cranked clock. What this file checks is the wiring.
 */

const HOME = new URL('../.tmp-activate/', import.meta.url).pathname.replace(/\/$/, '');
const PROJECTS = `${HOME}/.claude/projects`;
const FOLDER = '-repo';
const SESSION = `${PROJECTS}/${FOLDER}/aaa.jsonl`;
const SUBAGENT = `${PROJECTS}/${FOLDER}/aaa/subagents/agent-a1.jsonl`;

const user = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'user',
    uuid,
    cwd: '/repo',
    timestamp: '2026-08-01T10:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

const assistant = (id: string, output: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: '2026-08-01T10:00:01.000Z',
    requestId: `r-${id}`,
    message: {
      id,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'done' }],
    },
  })}\n`;

function write(path: string, text: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function harness() {
  const raw = new Map<string, unknown>();
  const storage: KV = {
    get: <T>(key: string, schema: Schema<T>): T | undefined => {
      if (!raw.has(key)) return undefined;
      const parsed = schema.parse(raw.get(key));
      return parsed.ok ? parsed.value : undefined;
    },
    set: (key, value) => void raw.set(key, value),
    delete: (key) => void raw.delete(key),
    keys: () => [...raw.keys()].sort(),
  };

  const registered = new Map<string, CommandSpec<unknown, unknown>>();
  const commands: CommandAPI = {
    register: (id, spec) => {
      registered.set(id, spec as unknown as CommandSpec<unknown, unknown>);
      return toDisposable(() => void registered.delete(id));
    },
    invoke: () => Promise.resolve({ ok: true, value: undefined as never }),
    list: () => [...registered.keys()].map((id) => ({ id })),
  };

  const emitted: { topic: string; payload: unknown }[] = [];
  const events: EventAPI = {
    emit: (topic, payload) => void emitted.push({ topic, payload }),
    on: () => toDisposable(() => {}),
  };

  const registry = new PointRegistry({ logger: nullLogger });
  registry.define<TranscriptSearchProvider>(TRANSCRIPT_SEARCH_POINT_ID, {
    order: 'registration',
    owner: 'shepherd.tasks',
  });

  const clock: ManualClock = manualClock(1);
  const ctx: ExtensionContext = {
    id: extensionId('shepherd.transcripts'),
    source: 'builtin',
    subscriptions: [],
    storage,
    dataDir: `${HOME}/data`,
    homeDir: HOME,
    userName: 'me',
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: nullLogger.child('extension'),
    clock,
    permissions: ['storage'],
    isDev: false,
  };

  activate(ctx, {
    version: '1.0.0',
    proposed: { commands, events, points: registry },
  } as unknown as Shepherd);

  return {
    emitted,
    clock,
    call: <R>(id: string, args: unknown): R => {
      const spec = registered.get(id);
      if (spec === undefined) throw new Error(`no command ${id}`);
      const parsed = spec.schema.parse(args);
      if (!parsed.ok) throw new Error(`bad args for ${id}`);
      return spec.handler(parsed.value, { kind: 'user' } as never) as R;
    },
    ids: () => [...registered.keys()],
    dispose: () => {
      for (const d of ctx.subscriptions) d.dispose();
    },
  };
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  write(SESSION, user('u1', 'hi') + assistant('m1', 10));
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe('activate', () => {
  it('registers the four commands', () => {
    expect(harness().ids().sort()).toEqual(
      [
        TRANSCRIPT_COMMANDS.read,
        TRANSCRIPT_COMMANDS.unwatch,
        TRANSCRIPT_COMMANDS.usage,
        TRANSCRIPT_COMMANDS.watch,
      ].sort(),
    );
  });

  it('reads one session in full', () => {
    const parsed = harness().call<ParsedSession | null>(TRANSCRIPT_COMMANDS.read, {
      path: SESSION,
    });
    expect(parsed?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(parsed?.sessionId).toBe('aaa');
  });

  it('answers null for a session that is not there', () => {
    expect(harness().call(TRANSCRIPT_COMMANDS.read, { path: `${HOME}/nope.jsonl` })).toBeNull();
  });

  it('leaves subagents out unless asked', () => {
    write(SUBAGENT, user('c1', 'child'));
    const h = harness();

    const alone = h.call<Record<string, unknown>>(TRANSCRIPT_COMMANDS.read, { path: SESSION });
    expect(alone.subagents).toBeUndefined();

    const withKids = h.call<{ subagents: readonly ParsedSession[] }>(TRANSCRIPT_COMMANDS.read, {
      path: SESSION,
      subagents: true,
    });
    expect(withKids.subagents).toHaveLength(1);
    expect(withKids.subagents[0]?.sessionId).toBe('agent-a1');
  });

  /** Their tokens were spent on the parent's behalf. */
  it('counts a session and its subagents together, always', () => {
    write(SUBAGENT, assistant('m2', 7));
    expect(harness().call<UsageRollup>(TRANSCRIPT_COMMANDS.usage, { path: SESSION }).total.output)
      .toBe(17);
  });

  it('counts a re-streamed row once', () => {
    write(SESSION, assistant('m1', 15) + assistant('m1', 40));
    expect(harness().call<UsageRollup>(TRANSCRIPT_COMMANDS.usage, { path: SESSION }).total.output)
      .toBe(40);
  });

  it('watches a file once, however many times it is asked', () => {
    const h = harness();
    expect(h.call(TRANSCRIPT_COMMANDS.watch, { path: SESSION })).toBe(true);
    expect(h.call(TRANSCRIPT_COMMANDS.watch, { path: SESSION })).toBe(false);
    h.dispose();
  });

  it('unwatches only what it was watching', () => {
    const h = harness();
    expect(h.call(TRANSCRIPT_COMMANDS.unwatch, { path: SESSION })).toBe(false);
    h.call(TRANSCRIPT_COMMANDS.watch, { path: SESSION });
    expect(h.call(TRANSCRIPT_COMMANDS.unwatch, { path: SESSION })).toBe(true);
    h.dispose();
  });

  it('emits what a watched file already holds, without waiting for an append', () => {
    const h = harness();
    h.call(TRANSCRIPT_COMMANDS.watch, { path: SESSION });
    h.clock.advance(1);

    const appended = h.emitted.filter((e) => e.topic === 'transcripts.appended');
    expect(appended).toHaveLength(1);
    h.dispose();
  });

  it('closes every tail on deactivate', () => {
    const h = harness();
    h.call(TRANSCRIPT_COMMANDS.watch, { path: SESSION });
    h.clock.advance(1);
    const before = h.emitted.length;

    h.dispose();
    h.clock.advance(1000);
    expect(h.emitted).toHaveLength(before);
  });
});
