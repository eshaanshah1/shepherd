// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Inspector } from './inspector.tsx';
import { all, mount, type Mounted } from './test-dom.ts';

/**
 * The GATE, not the measurement — `inspector-probe.test.ts` owns that half and
 * says what jsdom can prove about it.
 *
 * What is pinned here is the set of claims the rest of the app depends on:
 *
 *   - **off by default**, which is what makes "the smokes cannot see it" and
 *     "`window.capture` never photographs it" true without either of them
 *     knowing this file exists;
 *   - **⌘⇧I toggles it, in the page**, and swallows the keystroke — a terminal
 *     has focus almost always and an unswallowed ⇧I reaches the agent in it;
 *   - **Esc closes it, and only when it is open.** A global Esc handler that
 *     kept firing after the panel closed is the defect `view-overlay.tsx`
 *     records; the test for it is that a closed inspector leaves the event
 *     alone.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  delete document.documentElement.dataset['shInspecting'];
});

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const TOGGLE = { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true };

describe('Inspector', () => {
  it('draws nothing until it is asked for', () => {
    mounted = mount(<Inspector />);
    expect(all(document.body, 'token-inspector')).toHaveLength(0);
  });

  it('opens on ⌘⇧I and swallows the keystroke', () => {
    mounted = mount(<Inspector />);

    const event = press(TOGGLE);

    expect(all(document.body, 'token-inspector')).toHaveLength(1);
    // Or the focused terminal receives a stray ⇧I alongside the toggle.
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes on the same keystroke', () => {
    mounted = mount(<Inspector />);
    press(TOGGLE);
    press(TOGGLE);

    expect(all(document.body, 'token-inspector')).toHaveLength(0);
  });

  it('closes on Esc', () => {
    mounted = mount(<Inspector />);
    press(TOGGLE);

    const event = press({ key: 'Escape', code: 'Escape' });

    expect(all(document.body, 'token-inspector')).toHaveLength(0);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Esc alone when it is closed', () => {
    mounted = mount(<Inspector />);

    const event = press({ key: 'Escape', code: 'Escape' });

    expect(event.defaultPrevented).toBe(false);
  });

  it('flags the document while inspecting, and only while inspecting', () => {
    // The crosshair cursor hangs off this, and it is a mutation of the app's own
    // root — so it has to come back off.
    mounted = mount(<Inspector />);
    press(TOGGLE);
    expect(document.documentElement.dataset['shInspecting']).toBe('true');

    press(TOGGLE);
    expect(document.documentElement.dataset['shInspecting']).toBeUndefined();
  });
});
