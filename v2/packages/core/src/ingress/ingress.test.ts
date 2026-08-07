import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  s,
  sessionId,
  type Caller,
  type Envelope,
  type LogRecord,
  type Logger,
} from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants, type GrantSet } from '../commands/authorize.ts';
import { EventBus } from '../events/bus.ts';
import { EventsIngress } from './events-ingress.ts';
import { ControlIngress } from './control-ingress.ts';

let dir: string;
let records: LogRecord[];
let logger: Logger;
let bus: EventBus;
let commands: CommandRegistry;
let grants: GrantSet;
const stopping: { stop(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shepherd-ing2-'));
  records = [];
  const clock = manualClock(1_000);
  logger = createLogger({ clock, level: 'debug', sink: (_l, r) => records.push(r) });
  bus = new EventBus({ clock, logger });
  grants = emptyGrants();
  commands = new CommandRegistry({ logger, grants: () => grants });
});

afterEach(async () => {
  while (stopping.length > 0) await stopping.pop()?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const messages = () => records.map((r) => r.message);

function post(path: string, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method: 'POST' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function get(path: string, route: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function eventsAt(name = 'events.sock'): Promise<string> {
  const path = join(dir, name);
  const ingress = new EventsIngress({ path, bus, logger });
  stopping.push(ingress);
  const started = await ingress.start();
  if (!started.ok) throw new Error(started.error);
  return path;
}

async function controlAt(name = 'control.sock'): Promise<string> {
  const path = join(dir, name);
  const ingress = new ControlIngress({ path, commands, bus, logger });
  stopping.push(ingress);
  const started = await ingress.start();
  if (!started.ok) throw new Error(started.error);
  return path;
}

describe('events.sock', () => {
  it('publishes an envelope onto the bus and acks it', async () => {
    const path = await eventsAt();
    const seen: [unknown, Envelope][] = [];
    bus.on('claude.hook', (payload, envelope) => seen.push([payload, envelope]));

    const answer = await post(path, '/events', {
      topic: 'claude.hook',
      session_id: 's-1',
      seq: 3,
      payload: { event: 'Stop', background_tasks: [] },
    });

    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ ok: true, seq: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({ event: 'Stop', background_tasks: [] });
    expect(seen[0]?.[1].source).toEqual({ kind: 'agent', sessionId: 's-1' });
    expect(seen[0]?.[1].seq).toBe(3);
  });

  it('lets the bus number an envelope that carries no seq', async () => {
    const path = await eventsAt();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));

    await post(path, '/events', { topic: 't', session_id: 's-1' });
    await post(path, '/events', { topic: 't', session_id: 's-1' });
    expect(seqs).toEqual([1, 2]);
  });

  it('a payload-less envelope publishes an empty object, not undefined', async () => {
    const path = await eventsAt();
    const payloads: unknown[] = [];
    bus.on('t', (p) => payloads.push(p));
    await post(path, '/events', { topic: 't', session_id: 's-1' });
    expect(payloads).toEqual([{}]);
  });

  it('a malformed envelope is a 400 that says which field, and publishes nothing', async () => {
    const path = await eventsAt();
    let delivered = 0;
    bus.on('*', () => delivered++);

    const answer = await post(path, '/events', { topic: 'claude.hook' }); // no session_id
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toContain('session_id');
    expect(delivered).toBe(0);
    expect(messages().some((m) => m.includes('rejected an envelope'))).toBe(true);
  });

  it('carries a payload with newlines and quotes intact', async () => {
    // v1's hand-rolled bash JSON escaper missed newlines, which made the whole
    // event invalid JSON and therefore silently dropped. One `jq -cn` on the
    // client and a real parser here is the fix; this is the regression test for it.
    const path = await eventsAt();
    const payloads: unknown[] = [];
    bus.on('t', (p) => payloads.push(p));

    const nasty = 'line one\nline "two"\ttabbed\\backslash';
    await post(path, '/events', { topic: 't', session_id: 's-1', payload: { prompt: nasty } });
    expect(payloads).toEqual([{ prompt: nasty }]);
  });

  it('an out-of-order seq is delivered and logged as a gap', async () => {
    const path = await eventsAt();
    const seqs: number[] = [];
    bus.on('*', (_p, e) => seqs.push(e.seq));

    await post(path, '/events', { topic: 't', session_id: 's-1', seq: 1 });
    await post(path, '/events', { topic: 't', session_id: 's-1', seq: 4 });

    expect(seqs).toEqual([1, 4]);
    expect(messages().some((m) => /gap/i.test(m))).toBe(true);
  });

  it('two sessions are numbered independently', async () => {
    const path = await eventsAt();
    const sources: string[] = [];
    bus.on('*', (_p, e) => sources.push(`${e.source.kind}:${e.seq}`));
    await post(path, '/events', { topic: 't', session_id: 'a' });
    await post(path, '/events', { topic: 't', session_id: 'b' });
    expect(sources).toEqual(['agent:1', 'agent:1']);
  });
});

describe('control.sock', () => {
  it('invokes a command and returns its value', async () => {
    const path = await controlAt();
    commands.register('layout.split', {
      schema: s.object({ axis: s.enumOf(['row', 'column'] as const) }),
      handler: (args) => ({ node: `new-${args.axis}` }),
    });
    grants = { ...emptyGrants(), devices: new Map([['cli', []]]) };

    const answer = await post(path, '/invoke', {
      command: 'layout.split',
      args: { axis: 'row' },
      caller: { kind: 'device', deviceId: 'cli' },
    });

    expect(answer).toEqual({ status: 200, body: { ok: true, value: { node: 'new-row' } } });
  });

  it('maps each command failure onto a status a CLI can branch on', async () => {
    const path = await controlAt();
    commands.register('needs.layout', { schema: s.nothing(), permission: 'layout', handler: () => 0 });
    commands.register('takes.args', { schema: s.object({ cols: s.int() }), handler: () => 0 });
    grants = { ...emptyGrants(), devices: new Map([['cli', []]]) };
    const caller: Caller = { kind: 'device', deviceId: 'cli' };

    expect((await post(path, '/invoke', { command: 'no.such', caller })).status).toBe(404);
    expect((await post(path, '/invoke', { command: 'needs.layout', caller })).status).toBe(403);
    const bad = await post(path, '/invoke', { command: 'takes.args', args: { cols: 'x' }, caller });
    expect(bad.status).toBe(400);
    // The real reason survives the trip, so `shepherd` prints the field name.
    expect(JSON.stringify(bad.body)).toContain('cols');
  });

  it('REFUSES a client claiming to be the user', async () => {
    // The difference between an attributed caller and a self-declared one: a
    // `user` caller is minted by whatever saw the keystroke, never over a socket.
    const path = await controlAt();
    commands.register('anything', { schema: s.nothing(), handler: () => 'ran' });

    const answer = await post(path, '/invoke', { command: 'anything', caller: { kind: 'user' } });
    expect(answer.status).toBe(400);
  });

  it('denies an agent whose session is not live', async () => {
    const path = await controlAt();
    commands.register('tasks.spawn', { schema: s.nothing(), handler: () => 'spawned' });
    const answer = await post(path, '/invoke', {
      command: 'tasks.spawn',
      caller: { kind: 'agent', sessionId: 'ghost' },
    });
    expect(answer.status).toBe(403);
  });

  it('lets a granted extension through', async () => {
    const path = await controlAt();
    const TASKS = extensionId('shepherd.tasks');
    commands.register('storage.write', { schema: s.nothing(), permission: 'storage', handler: () => 'wrote' });
    grants = { ...emptyGrants(), extensions: new Map([[TASKS, ['storage']]]) };

    const answer = await post(path, '/invoke', {
      command: 'storage.write',
      caller: { kind: 'extension', id: 'shepherd.tasks' },
    });
    expect(answer).toEqual({ status: 200, body: { ok: true, value: 'wrote' } });
  });

  it('lists commands for a palette or a help screen', async () => {
    const path = await controlAt();
    commands.register('a.cmd', { schema: s.nothing(), title: 'Do A', handler: () => 0 });
    const answer = await get(path, '/commands');
    expect(answer.body).toEqual({ ok: true, value: [{ id: 'a.cmd', title: 'Do A' }] });
  });

  it('adds no verbs of its own — an unknown route is a 404', async () => {
    const path = await controlAt();
    expect((await post(path, '/split', {})).status).toBe(404);
  });
});

describe('the wait subscription', () => {
  it('pushes matching events to a live client and drops the subscription when it leaves', async () => {
    const path = await controlAt();
    const lines: unknown[] = [];

    const req = request({ socketPath: path, path: '/subscribe?topic=agent.*', method: 'GET' });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      req.on('response', resolve);
      req.end();
    });
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line !== '') lines.push(JSON.parse(line));
    });

    await waitFor(() => messages().some((m) => m.includes('subscriber attached')));

    bus.emit('agent.state', { state: 'working' }, { kind: 'agent', sessionId: sessionId('s-1') });
    bus.emit('other.topic', { ignored: true }, { kind: 'user' });
    bus.emit('agent.state', { state: 'idle' }, { kind: 'agent', sessionId: sessionId('s-1') });

    await waitFor(() => lines.length === 2);
    expect(lines).toEqual([
      { topic: 'agent.*', payload: { state: 'working' }, envelope: { seq: 1, ts: 1_000, source: { kind: 'agent', sessionId: 's-1' } } },
      { topic: 'agent.*', payload: { state: 'idle' }, envelope: { seq: 2, ts: 1_000, source: { kind: 'agent', sessionId: 's-1' } } },
    ]);

    req.destroy();
    await waitFor(() => messages().some((m) => m.includes('subscriber left')));
  });

  it('a hook event reaches a waiting subscriber end to end', async () => {
    // Both sockets over one bus: this is the shape `shepherd wait` actually has —
    // an agent's hook lands on events.sock and a CLI blocked on control.sock sees
    // it, with nothing polled anywhere.
    const eventsPath = await eventsAt();
    const controlPath = await controlAt();
    const lines: { payload: unknown }[] = [];

    const req = request({ socketPath: controlPath, path: '/subscribe?topic=claude.hook', method: 'GET' });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      req.on('response', resolve);
      req.end();
    });
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line !== '') lines.push(JSON.parse(line) as { payload: unknown });
    });
    await waitFor(() => messages().some((m) => m.includes('subscriber attached')));

    await post(eventsPath, '/events', { topic: 'claude.hook', session_id: 's-1', payload: { event: 'Stop' } });

    await waitFor(() => lines.length === 1);
    expect(lines[0]?.payload).toEqual({ event: 'Stop' });
    req.destroy();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
