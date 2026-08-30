import { describe, expect, it } from 'vitest';
import { LayoutStore } from '@shepherd/core/layout';
import { ViewingResolver } from '@shepherd/core';
import { nullLogger, rootId, systemClock } from '@shepherd/sdk';
import { presenceFor } from './presence-input.ts';

const ROOT = rootId('window-1');

describe('presenceFor', () => {
  it('reports the active root while the app is frontmost', () => {
    expect(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: false })).toEqual({
      appActive: true,
      focusedRoot: ROOT,
      overlay: false,
    });
  });

  it('reports NO focused root when the app is not frontmost', () => {
    // A switch driven from the CLI while Shepherd is in the background must not
    // resurrect one, or attention clears on panes nobody has seen.
    expect(presenceFor({ appActive: false, activeRoot: ROOT, settingsOpen: false }).focusedRoot).toBeNull();
  });

  it('reports a takeover when the settings screen is up', () => {
    expect(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: true }).overlay).toBe(true);
  });
});

/**
 * The invariant this whole file exists for, asserted through the REAL resolver.
 *
 * A test that asserted `overlay === true` and stopped would be asserting the
 * function's own return value. What matters is the consequence: with the settings
 * screen up, `isViewing` answers false for a pane that is focused, on screen, in
 * the active root of a frontmost app — so an agent that blocks behind settings
 * still notifies, and reading settings does not clear its need-to-check.
 */
describe('the settings screen and the one viewing predicate (ADR 0020)', () => {
  const build = () => {
    // The same construction `viewing-topic.test.ts` uses — a real store, a
    // session sink that kills nothing.
    const layout = new LayoutStore({
      logger: nullLogger,
      clock: systemClock,
      sessions: { release: () => undefined, isLive: () => true },
    });
    layout.open(ROOT);
    const pane = layout.focused(ROOT);
    if (pane === null) throw new Error('a fresh root has a focused pane');
    const viewing = new ViewingResolver(
      layout,
      presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: false }),
      nullLogger,
    );
    return { layout, viewing, pane };
  };

  it('is viewing the focused pane with nothing over it', () => {
    const { viewing, pane } = build();
    expect(viewing.isViewing(pane)).toBe(true);
  });

  it('is NOT viewing it while the settings screen covers the grid', () => {
    const { viewing, pane } = build();
    viewing.setPresence(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: true }));
    expect(viewing.isViewing(pane)).toBe(false);
  });

  it('is viewing it again the moment the screen closes', () => {
    const { viewing, pane } = build();
    viewing.setPresence(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: true }));
    viewing.setPresence(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: false }));
    expect(viewing.isViewing(pane)).toBe(true);
  });

  it('announces the edge, so a cached answer a process away is corrected', () => {
    // `agents-core` holds a cache of this predicate rather than asking again
    // (`viewing-topic.ts`). A takeover that changed the answer without firing
    // would leave that cache saying the user is watching a pane they cannot see.
    const { viewing, pane } = build();
    const edges: [string, boolean][] = [];
    viewing.onDidChangeViewing((changed, next) => edges.push([changed, next]));
    viewing.setPresence(presenceFor({ appActive: true, activeRoot: ROOT, settingsOpen: true }));
    expect(edges).toEqual([[pane, false]]);
  });
});
