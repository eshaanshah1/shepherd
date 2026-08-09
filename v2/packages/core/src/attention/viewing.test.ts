import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  manualClock,
  paneId,
  rootId,
  type LogRecord,
  type Logger,
  type ManualClock,
  type PaneID,
  type SessionID,
} from '@shepherd/sdk';
import { LayoutStore, type SessionSink } from '../layout/store.ts';
import { ViewingResolver, type Presence } from './viewing.ts';

let records: LogRecord[];
let logger: Logger;
let clock: ManualClock;
let sessions: SessionSink;
let ids: number;

beforeEach(() => {
  records = [];
  clock = manualClock(0);
  logger = createLogger({ clock, level: 'debug', sink: (_l, r) => records.push(r) });
  const killed: SessionID[] = [];
  // R1 widened `SessionSink`; nothing here exercises the restore path.
  sessions = { kill: (id) => killed.push(id), isLive: () => true };
  ids = 0;
});

const newPane = () => `p${++ids}`;

function build(): LayoutStore {
  return new LayoutStore({ logger, clock, sessions, newPane });
}

const WINDOW = rootId('window-1');

function present(patch: Partial<Presence> = {}): Presence {
  return { appActive: true, focusedRoot: WINDOW, overlay: false, ...patch };
}

describe('isFrontPane', () => {
  it('is the focused pane of the focused root', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row'); // focus lands on p2

    const viewing = new ViewingResolver(store, present());
    expect(viewing.isFrontPane(paneId('p2'))).toBe(true);
    expect(viewing.isFrontPane(paneId('p1'))).toBe(false);
  });

  it('is false for every pane of a root that is not frontmost', () => {
    const store = build();
    store.open('window-1');
    store.open('window-2');
    const viewing = new ViewingResolver(store, present({ focusedRoot: rootId('window-2') }));
    expect(viewing.isFrontPane(paneId('p1'))).toBe(false);
    expect(viewing.isFrontPane(paneId('p2'))).toBe(true);
  });

  it('is false when no window is frontmost', () => {
    const store = build();
    store.open();
    const viewing = new ViewingResolver(store, present({ focusedRoot: null }));
    expect(viewing.isFrontPane(paneId('p1'))).toBe(false);
  });

  it('is false under a full-takeover overlay', () => {
    // v1: `isFrontPane` requires no diff panel and no code surface — a workbench
    // over the terminal means the terminal is not what you are looking at.
    const store = build();
    store.open();
    const viewing = new ViewingResolver(store, present({ overlay: true }));
    expect(viewing.isFrontPane(paneId('p1'))).toBe(false);
  });

  it('a ZOOMED pane is front', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.zoom(paneId('p2'));
    const viewing = new ViewingResolver(store, present());
    expect(viewing.isFrontPane(paneId('p2'))).toBe(true);
  });

  it('a pane whose SIBLING is zoomed is not front', () => {
    // It is starved to 0x0 and still mounted, which is exactly why the check has
    // to exist: the pane is alive, focusable in the model, and invisible.
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.zoom(paneId('p2'));
    store.focusPane(paneId('p1'));
    const viewing = new ViewingResolver(store, present());
    expect(viewing.isFrontPane(paneId('p1'))).toBe(false);
  });

  it('resolves focus through the store, so a stale focused id cannot answer', () => {
    // `store.focused` falls back to the first leaf when the focused pane is gone.
    // Caching the id here would keep reporting a closed pane as front.
    const store = build();
    const root = store.open();
    store.split(root, 'row'); // focus = p2
    const viewing = new ViewingResolver(store, present());
    store.close(paneId('p2'));
    expect(viewing.isFrontPane(paneId('p2'))).toBe(false);
    expect(viewing.isFrontPane(paneId('p1'))).toBe(true);
  });
});

describe('isViewing', () => {
  it('is isFrontPane plus the app being active', () => {
    const store = build();
    store.open();
    const viewing = new ViewingResolver(store, present({ appActive: false }));
    expect(viewing.isFrontPane(paneId('p1'))).toBe(true);
    expect(viewing.isViewing(paneId('p1'))).toBe(false);

    viewing.setPresence(present({ appActive: true }));
    expect(viewing.isViewing(paneId('p1'))).toBe(true);
  });
});

describe('onDidChangeViewing', () => {
  it('fires only for panes whose viewing-ness actually changed', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row'); // p1 | p2, focus on p2
    const viewing = new ViewingResolver(store, present({ appActive: false }));
    const seen: [PaneID, boolean][] = [];
    viewing.onDidChangeViewing((pane, is) => seen.push([pane, is]));

    viewing.setPresence(present({ appActive: true }));
    // p1 was not viewed before and is not viewed now — announcing it would make
    // every subscriber re-decide for a pane nothing happened to.
    expect(seen).toEqual([['p2', true]]);
  });

  it('does not fire when presence is set to the same value', () => {
    const store = build();
    store.open();
    const viewing = new ViewingResolver(store, present());
    let count = 0;
    viewing.onDidChangeViewing(() => count++);
    viewing.setPresence(present());
    expect(count).toBe(0);
  });

  it('re-evaluates on a layout focus change', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row'); // focus = p2
    const viewing = new ViewingResolver(store, present());
    const seen: [PaneID, boolean][] = [];
    viewing.onDidChangeViewing((pane, is) => seen.push([pane, is]));

    store.focusPane(paneId('p1'));
    expect(seen).toEqual([
      ['p1', true],
      ['p2', false],
    ]);
  });

  it('re-evaluates on a zoom change', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    store.focusPane(paneId('p1'));
    const viewing = new ViewingResolver(store, present());
    const seen: [PaneID, boolean][] = [];
    viewing.onDidChangeViewing((pane, is) => seen.push([pane, is]));

    store.zoom(paneId('p2')); // p1 is now starved
    expect(seen).toEqual([['p1', false]]);
  });

  it('a viewed pane that is closed reports false rather than vanishing quietly', () => {
    // A subscriber that cached "p2 is being viewed" must be told otherwise, or it
    // keeps suppressing alerts for a pane that no longer exists.
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    const viewing = new ViewingResolver(store, present());
    const seen: [PaneID, boolean][] = [];
    viewing.onDidChangeViewing((pane, is) => seen.push([pane, is]));

    store.close(paneId('p2'));
    expect(seen).toEqual([
      ['p2', false],
      ['p1', true],
    ]);
  });

  it('does not fire for a layout change that alters nothing visible', () => {
    const store = build();
    store.open();
    const viewing = new ViewingResolver(store, present());
    let count = 0;
    viewing.onDidChangeViewing(() => count++);
    store.rename(paneId('p1'), 'the one');
    store.observe(paneId('p1'), { cwd: '/elsewhere' });
    expect(count).toBe(0);
  });

  it('survives a throwing listener, and says so', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    const viewing = new ViewingResolver(store, present(), logger);
    const seen: PaneID[] = [];
    viewing.onDidChangeViewing(() => {
      throw new Error('listener bug');
    });
    viewing.onDidChangeViewing((pane) => seen.push(pane));
    store.focusPane(paneId('p1'));
    expect(seen).toContain(paneId('p1'));
    expect(records.map((r) => r.message).some((m) => m.includes('listener bug'))).toBe(true);
  });

  it('stops on dispose', () => {
    const store = build();
    const root = store.open();
    store.split(root, 'row');
    const viewing = new ViewingResolver(store, present());
    let count = 0;
    viewing.onDidChangeViewing(() => count++);
    viewing.dispose();
    store.focusPane(paneId('p1'));
    viewing.setPresence(present({ appActive: false }));
    expect(count).toBe(0);
  });
});
