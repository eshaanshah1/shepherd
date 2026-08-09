import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  extensionId,
  manualClock,
  paneId,
  rootId,
  sessionId,
  type AttentionAPI,
  type AttentionLevel,
  type Caller,
  type Envelope,
  type LogRecord,
  type Logger,
  type ManualClock,
  type PaneID,
  type Permission,
  type SessionID,
} from '@shepherd/sdk';
import { CommandRegistry } from '../commands/registry.ts';
import { emptyGrants, type GrantSet } from '../commands/authorize.ts';
import { EventBus } from '../events/bus.ts';
import { LayoutStore, type SessionSink } from '../layout/store.ts';
import { AttentionStore, ATTENTION_TOPIC, type AttentionChanged } from './store.ts';
import { ATTENTION_COMMANDS, registerAttentionCommands } from './commands.ts';
import { ViewingResolver, type Presence } from './viewing.ts';

const USER: Caller = { kind: 'user' };
const WINDOW = rootId('window-1');

let records: LogRecord[];
let logger: Logger;
let clock: ManualClock;
let sessions: SessionSink;
let ids: number;

beforeEach(() => {
  records = [];
  clock = manualClock(0);
  logger = createLogger({ clock, level: 'debug', sink: (_l, r) => records.push(r) });
  // R1: a `SessionSink` must also answer whether a session is still alive.
  // Always true here; the restore path that consumes it has its own cases in
  // `layout/store.test.ts`.
  sessions = { kill: () => {}, isLive: () => true };
  ids = 0;
});

const messages = () => records.map((r) => r.message);
const newPane = () => `p${++ids}`;

function present(patch: Partial<Presence> = {}): Presence {
  return { appActive: true, focusedRoot: WINDOW, overlay: false, ...patch };
}

interface Wired {
  readonly layout: LayoutStore;
  readonly viewing: ViewingResolver;
  readonly attention: AttentionStore;
  readonly bus: EventBus;
  readonly events: { readonly payload: AttentionChanged; readonly envelope: Envelope }[];
}

/** A root with two panes (`p1` | `p2`, focus on p2) plus the whole attention wiring. */
function wired(presence: Presence = present({ appActive: false })): Wired {
  const layout = new LayoutStore({ logger, clock, sessions, newPane });
  const root = layout.open();
  layout.split(root, 'row');
  const viewing = new ViewingResolver(layout, presence);
  const bus = new EventBus({ clock, logger });
  const events: { payload: AttentionChanged; envelope: Envelope }[] = [];
  bus.on<AttentionChanged>(ATTENTION_TOPIC, (payload, envelope) => events.push({ payload, envelope }));
  const attention = new AttentionStore({ layout, viewing, bus, logger });
  return { layout, viewing, attention, bus, events };
}

const ATTENTION = { level: 'attention' as AttentionLevel, reason: 'answer needed' };
const URGENT = { level: 'urgent' as AttentionLevel, reason: 'approve Bash' };
const INFO = { level: 'info' as AttentionLevel, reason: 'resolve conflicts' };

describe('set / get / clear', () => {
  it('stores by pane and reads back', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    expect(attention.get(paneId('p1'))).toEqual(ATTENTION);
    expect(attention.get(paneId('p2'))).toBeUndefined();
  });

  it('a session id resolves to its pane, and either handle reads it back', () => {
    // A caller may address either; storing canonically by pane is what keeps one
    // answer when a session is rebound to a different pane.
    const { attention, layout } = wired();
    layout.bindSession(paneId('p1'), sessionId('s-1'));
    attention.set(sessionId('s-1'), ATTENTION);
    expect(attention.get(paneId('p1'))).toEqual(ATTENTION);
    expect(attention.get(sessionId('s-1'))).toEqual(ATTENTION);
  });

  it('a session with no pane is dropped WITH a log line, not silently', () => {
    // "A session may have none" is in the LayoutAPI's own doc. An unroutable set
    // that says nothing is indistinguishable from attention that stopped working.
    const { attention } = wired();
    attention.set(sessionId('s-nowhere'), ATTENTION);
    expect(attention.count()).toBe(0);
    expect(messages().some((m) => m.includes('s-nowhere'))).toBe(true);
  });

  it('an unknown pane is dropped WITH a log line', () => {
    const { attention } = wired();
    attention.set(paneId('ghost'), URGENT);
    expect(attention.get(paneId('ghost'))).toBeUndefined();
    expect(messages().some((m) => m.includes('ghost'))).toBe(true);
  });

  it('level `none` is a clear', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p1'), { level: 'none', reason: 'done' });
    expect(attention.get(paneId('p1'))).toBeUndefined();
  });

  it('clear removes the entry, and clearing nothing is not an error', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    attention.clear(paneId('p1'));
    expect(attention.get(paneId('p1'))).toBeUndefined();
    attention.clear(paneId('p1'));
    expect(attention.count()).toBe(0);
  });

  it('satisfies the SDK AttentionAPI', () => {
    // The shape extensions are typed against. Extra optional parameters are fine;
    // a missing method or a wrong target union is not.
    const { attention } = wired();
    const api: AttentionAPI = attention;
    api.set(paneId('p1') as unknown as SessionID, ATTENTION);
    expect(api.count()).toBe(1);
    api.clear(paneId('p1') as unknown as SessionID);
    expect(api.get(paneId('p1') as unknown as SessionID)).toBeUndefined();
  });
});

describe('count — the dock badge', () => {
  it('counts attention and urgent panes across EVERY root', () => {
    // A pane in a window that is not frontmost still needs you. v1's badge
    // aggregated over every pane of every tab of every workspace for this reason.
    const { attention, layout } = wired();
    const second = layout.open('window-2');
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), URGENT);
    attention.set(layout.panes(second)[0]!, ATTENTION);
    expect(attention.count()).toBe(3);
  });

  it('does NOT count info', () => {
    // Chosen deliberately: `count()` and `ring()` are ONE set. A badge that ⌘⇧A
    // cannot reach is the two-sources divergence this kernel exists to kill, and
    // v1's non-urgent nudge tier was likewise chrome-visible and badge-silent.
    const { attention } = wired();
    attention.set(paneId('p1'), INFO);
    expect(attention.count()).toBe(0);
  });

  it('a closed pane stops counting', () => {
    // Nothing else purges the entry, so without this the badge shows a pane that
    // no longer exists and can never be cleared by looking at it.
    const { attention, layout } = wired();
    attention.set(paneId('p2'), URGENT);
    expect(attention.count()).toBe(1);
    layout.close(paneId('p2'));
    expect(attention.count()).toBe(0);
    expect(attention.get(paneId('p2'))).toBeUndefined();
  });
});

describe('aggregate — the folder/tab dot', () => {
  it('is the worst level in the root', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), URGENT);
    expect(attention.aggregate(WINDOW)).toBe('urgent');
  });

  it('surfaces info when nothing worse is pending — the dot is where info lives', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), INFO);
    expect(attention.aggregate(WINDOW)).toBe('info');
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.aggregate(WINDOW)).toBe('attention');
  });

  it('is `none` for a root with nothing pending, and for an unknown root', () => {
    const { attention } = wired();
    expect(attention.aggregate(WINDOW)).toBe('none');
    expect(attention.aggregate(rootId('nope'))).toBe('none');
  });

  it('does not leak across roots', () => {
    const { attention, layout } = wired();
    const second = layout.open('window-2');
    attention.set(layout.panes(second)[0]!, URGENT);
    expect(attention.aggregate(WINDOW)).toBe('none');
    expect(attention.aggregate(second)).toBe('urgent');
  });
});

describe('ring — the ⌘⇧A order', () => {
  it('is urgent first, then attention, stable within a level', () => {
    const { attention, layout } = wired();
    layout.split(WINDOW, 'row'); // p3
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), ATTENTION);
    attention.set(paneId('p3'), URGENT);
    expect(attention.ring()).toEqual(['p3', 'p1', 'p2']);
  });

  it('keeps insertion order when a level is re-set rather than jumping to the end', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), ATTENTION);
    attention.set(paneId('p1'), { level: 'attention', reason: 'still waiting' });
    expect(attention.ring()).toEqual(['p1', 'p2']);
  });

  it('excludes info — the same set the badge counts', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), INFO);
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.ring()).toEqual(['p2']);
  });

  it('spans roots, because ⌘⇧A must reach a pane in a window you are not looking at', () => {
    const { attention, layout } = wired();
    const second = layout.open('window-2');
    const other = layout.panes(second)[0]!;
    attention.set(paneId('p1'), ATTENTION);
    attention.set(other, ATTENTION);
    expect(attention.ring()).toEqual(['p1', other]);
  });

  it('next wraps', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.next()).toBe('p1');
    expect(attention.next(paneId('p1'))).toBe('p2');
    expect(attention.next(paneId('p2'))).toBe('p1');
  });

  it('next from a pane outside the ring starts at the front', () => {
    // ⌘⇧A pressed while sitting in a perfectly calm pane still has to go somewhere.
    const { attention } = wired();
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.next(paneId('p1'))).toBe('p2');
  });

  it('next is undefined when nothing wants attention', () => {
    const { attention } = wired();
    expect(attention.next()).toBeUndefined();
    expect(attention.ring()).toEqual([]);
  });
});

describe('change notification and the bus', () => {
  it('emits attention.changed on a level change, with pane, level and reason', () => {
    const { attention, events } = wired();
    attention.set(paneId('p1'), ATTENTION);
    expect(events.map((e) => e.payload)).toEqual([{ pane: 'p1', level: 'attention', reason: 'answer needed' }]);
    expect(events[0]!.envelope.seq).toBe(1);
  });

  it('does not re-emit when only the reason changed, but does notify listeners', () => {
    const { attention, events } = wired();
    let changes = 0;
    attention.onDidChange(() => changes++);
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p1'), { level: 'attention', reason: 'a different question' });
    expect(events).toHaveLength(1);
    expect(changes).toBe(2);
    expect(attention.get(paneId('p1'))?.reason).toBe('a different question');
  });

  it('a clear emits level none', () => {
    const { attention, events } = wired();
    attention.set(paneId('p1'), URGENT);
    attention.clear(paneId('p1'));
    expect(events.map((e) => e.payload.level)).toEqual(['urgent', 'none']);
  });

  it('attributes the event to the caller that set it', () => {
    // Threaded, not invented: the registry already carries an attributed caller,
    // and the bus numbers sequences PER source, so a wrong label pollutes another
    // source's counter.
    const { attention, events } = wired();
    const caller: Caller = { kind: 'extension', id: extensionId('shepherd.claude-code') };
    attention.set(paneId('p1'), ATTENTION, caller);
    expect(events[0]!.envelope.source).toEqual(caller);
  });

  it('survives a throwing listener', () => {
    const { attention } = wired();
    const seen: number[] = [];
    attention.onDidChange(() => {
      throw new Error('listener bug');
    });
    attention.onDidChange(() => seen.push(1));
    attention.set(paneId('p1'), ATTENTION);
    expect(seen).toEqual([1]);
    expect(messages().some((m) => m.includes('listener bug'))).toBe(true);
  });

  it('does not notify when nothing changed', () => {
    const { attention } = wired();
    attention.set(paneId('p1'), ATTENTION);
    let changes = 0;
    attention.onDidChange(() => changes++);
    attention.set(paneId('p1'), ATTENTION);
    expect(changes).toBe(0);
  });
});

describe('decide — routing with viewing computed ONCE', () => {
  it('suppresses everything for the pane in front of you', () => {
    const { attention } = wired(present()); // app active, focus = p2
    attention.set(paneId('p2'), ATTENTION);
    const decision = attention.decide(paneId('p2'), { turnFinished: true });
    expect(decision).toMatchObject({ banner: false, chime: false, push: false, badge: false });
  });

  it('alerts for a pane on the same window that you are not focused on', () => {
    // v1: a pane on another tab of the same workspace DOES notify.
    const { attention } = wired(present());
    attention.set(paneId('p1'), ATTENTION);
    expect(attention.decide(paneId('p1'), { turnFinished: true })).toMatchObject({
      banner: true,
      chime: true,
      push: false,
      badge: true,
    });
  });

  it('routes the phone when away, even for the pane that is nominally front', () => {
    const { attention } = wired(present());
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.decide(paneId('p2'), { away: true })).toMatchObject({
      banner: false,
      chime: false,
      push: true,
    });
  });

  it('reads the stored level when the caller does not name one', () => {
    const { attention } = wired();
    expect(attention.decide(paneId('p1'))).toMatchObject({ badge: false });
    attention.set(paneId('p1'), URGENT);
    expect(attention.decide(paneId('p1'))).toMatchObject({ badge: true, chime: true });
  });
});

describe('clearing on focus', () => {
  it('an attention pane clears when it becomes viewed', () => {
    // v1's table: need-to-check → idle on focus / select / app-becomes-active.
    // `didFocus` fired on a focus CHANGE, so before ADR 0020 there was no event
    // that could clear a pane which finished while in front of you.
    const { attention, viewing } = wired();
    attention.set(paneId('p2'), ATTENTION);
    viewing.setPresence(present({ appActive: true })); // p2 is the focused pane
    expect(attention.get(paneId('p2'))).toBeUndefined();
  });

  it('an URGENT pane is not cleared merely by looking at it', () => {
    // Only need-to-check clears; never blocked. Looking at a permission prompt is
    // not answering it, and clearing it would drop the one signal you act on.
    const { attention, viewing } = wired();
    attention.set(paneId('p2'), URGENT);
    viewing.setPresence(present({ appActive: true }));
    expect(attention.get(paneId('p2'))).toEqual(URGENT);
  });

  it('an INFO condition is not cleared by looking either', () => {
    // A nudge is a condition: it goes away when the condition does (the conflict
    // is resolved), not when you glance at the pane.
    const { attention, viewing } = wired();
    attention.set(paneId('p2'), INFO);
    viewing.setPresence(present({ appActive: true }));
    expect(attention.get(paneId('p2'))).toEqual(INFO);
  });

  it('does not clear a pane you are not looking at', () => {
    const { attention, viewing } = wired();
    attention.set(paneId('p1'), ATTENTION);
    viewing.setPresence(present({ appActive: true })); // focus is on p2
    expect(attention.get(paneId('p1'))).toEqual(ATTENTION);
  });

  it('a set on a pane you are ALREADY viewing is stored, not swallowed', () => {
    // The landing decision (idle vs need-to-check) belongs to the producer's state
    // machine, which threads `decide()`'s viewing value. Core clearing it here as
    // well would be the second visibility check ADR 0020 forbids — and it would
    // make `get` after `set` return undefined.
    const { attention } = wired(present());
    attention.set(paneId('p2'), ATTENTION);
    expect(attention.get(paneId('p2'))).toEqual(ATTENTION);
  });

  it('emits the clear on the bus so the badge and any mirror agree', () => {
    const { attention, viewing, events } = wired();
    attention.set(paneId('p2'), ATTENTION);
    viewing.setPresence(present({ appActive: true }));
    expect(events.map((e) => e.payload.level)).toEqual(['attention', 'none']);
  });

  it('stops on dispose', () => {
    const { attention, viewing } = wired();
    attention.set(paneId('p2'), ATTENTION);
    attention.dispose();
    viewing.setPresence(present({ appActive: true }));
    expect(attention.get(paneId('p2'))).toEqual(ATTENTION);
  });
});

describe('as commands', () => {
  function withCommands(grants: GrantSet = emptyGrants()) {
    const base = wired();
    const registry = new CommandRegistry({ logger, grants: () => grants });
    const subscription = registerAttentionCommands({ store: base.attention, registry });
    return { ...base, registry, subscription };
  }

  it('sets through the registry', async () => {
    const { registry, attention } = withCommands();
    const result = await registry.invoke(
      ATTENTION_COMMANDS.set,
      { target: 'p1', level: 'attention', reason: 'answer needed' },
      USER,
    );
    expect(result).toEqual({ ok: true, value: { pane: 'p1', level: 'attention' } });
    expect(attention.get(paneId('p1'))).toEqual({ level: 'attention', reason: 'answer needed' });
  });

  it('clears through the registry', async () => {
    const { registry, attention } = withCommands();
    attention.set(paneId('p1'), ATTENTION);
    const result = await registry.invoke(ATTENTION_COMMANDS.clear, { target: 'p1' }, USER);
    expect(result).toEqual({ ok: true, value: { pane: 'p1' } });
    expect(attention.count()).toBe(0);
  });

  it('carries the invoking caller into the emitted event', async () => {
    const grants: GrantSet = {
      ...emptyGrants(),
      devices: new Map<string, readonly Permission[]>([['phone', ['attention']]]),
    };
    const { registry, events } = withCommands(grants);
    const caller: Caller = { kind: 'device', deviceId: 'phone' };
    await registry.invoke(ATTENTION_COMMANDS.set, { target: 'p1', level: 'urgent', reason: 'tapped' }, caller);
    expect(events[0]!.envelope.source).toEqual(caller);
  });

  it('both commands demand the attention permission', async () => {
    // So an extension cannot light the dock badge without having asked.
    const { registry } = withCommands();
    const caller: Caller = { kind: 'device', deviceId: 'phone' };
    for (const id of Object.values(ATTENTION_COMMANDS)) {
      const result = await registry.invoke(id, { target: 'p1', level: 'info', reason: 'x' }, caller);
      expect(result.ok, `${id} should be denied`).toBe(false);
      if (!result.ok) expect(result.error.code, `${id}`).toBe('denied');
    }
  });

  it('rejects an unknown level before touching the store', async () => {
    const { registry, attention } = withCommands();
    const result = await registry.invoke(
      ATTENTION_COMMANDS.set,
      { target: 'p1', level: 'panic', reason: 'x' },
      USER,
    );
    expect(result.ok).toBe(false);
    expect(attention.count()).toBe(0);
  });

  it('an unroutable target is a typed error, not a throw and not a silent success', async () => {
    const { registry } = withCommands();
    const result = await registry.invoke(
      ATTENTION_COMMANDS.set,
      { target: 'ghost', level: 'urgent', reason: 'x' },
      USER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('handler-failed');
      expect(result.error.message).toContain('ghost');
    }
  });

  it('disposing unregisters the whole table', () => {
    const { registry, subscription } = withCommands();
    subscription.dispose();
    for (const id of Object.values(ATTENTION_COMMANDS)) expect(registry.has(id)).toBe(false);
  });
});

describe('a pane addressed both ways', () => {
  it('prefers the session mapping, then falls back to the pane id', () => {
    // The two id spaces are opaque strings at runtime. Resolving sessions first is
    // the documented order; nothing may depend on a string being "obviously" one.
    const { attention, layout } = wired();
    layout.bindSession(paneId('p1'), sessionId('p2'));
    attention.set(sessionId('p2'), ATTENTION);
    expect(attention.get(paneId('p1'))).toEqual(ATTENTION);
  });
});

describe('the ring survives a pane closing under it', () => {
  it('drops the closed pane and keeps the rest in order', () => {
    const { attention, layout } = wired();
    layout.split(WINDOW, 'row'); // p3
    attention.set(paneId('p1'), ATTENTION);
    attention.set(paneId('p2'), ATTENTION);
    attention.set(paneId('p3'), ATTENTION);
    layout.close(paneId('p2'));
    expect(attention.ring()).toEqual(['p1', 'p3']);
  });
});
