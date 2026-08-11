// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { IconPlus } from '@tabler/icons-react';
import { rulesMentioning } from './css-rules.ts';
import { TabStrip } from './tab-strip.tsx';
import { mount } from './test-dom.ts';
import './styles.css';

/** Every tab button, in draw order. */
const tabs = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
/** The new-tab control, or null when the strip drew none. */
const newTab = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[data-testid="tab-new"]');

/**
 * The tabs of one pane group.
 *
 * What these assert is the CONTRACT, not the paint: that exactly one tab reports
 * itself selected to a screen reader, that a click answers with the tab's id
 * rather than its index, and that the new-tab control exists only when it has
 * somewhere to send the gesture.
 */

const TABS = [
  { id: 'a', label: 'api' },
  { id: 'b', label: 'logs' },
];

describe('TabStrip', () => {
  it('marks the active tab, and only it', () => {
    // `aria-selected`, not a class: a tab whose only state is a colour is a tab
    // a screen reader cannot report at all.
    const view = mount(<TabStrip tabs={TABS} activeId="b" onSelect={() => {}} />);
    expect(tabs(view.container).map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);
    view.unmount();
  });

  it('reports the id that was clicked', () => {
    // The ID, never the index: the caller's roots are what it acts on, and a
    // list that reorders would make an index name the wrong tab.
    const chosen: string[] = [];
    const view = mount(<TabStrip tabs={TABS} activeId="a" onSelect={(id) => chosen.push(id)} />);
    act(() => tabs(view.container)[1]?.click());
    expect(chosen).toEqual(['b']);
    view.unmount();
  });

  it('draws no new-tab control when it has nowhere to send it', () => {
    const view = mount(<TabStrip tabs={TABS} activeId="a" onSelect={() => {}} />);
    expect(newTab(view.container)).toBeNull();
    view.unmount();
  });

  it('runs the new-tab gesture when it has one', () => {
    let made = 0;
    const view = mount(
      <TabStrip tabs={TABS} activeId="a" onSelect={() => {}} onNew={() => (made += 1)} newIcon={IconPlus} />,
    );
    act(() => newTab(view.container)?.click());
    expect(made).toBe(1);
    view.unmount();
  });

  it('names the new-tab control, because an icon alone names nothing', () => {
    const view = mount(
      <TabStrip tabs={TABS} activeId="a" onSelect={() => {}} onNew={() => {}} newIcon={IconPlus} />,
    );
    expect(newTab(view.container)?.getAttribute('aria-label')).toBe('New tab');
    view.unmount();
  });

  it('selects nothing when the active id names no tab', () => {
    // A group whose active root has just been closed, for the instant before the
    // next snapshot lands. Better to select none than to light the wrong one.
    const view = mount(<TabStrip tabs={TABS} activeId="gone" onSelect={() => {}} />);
    expect(tabs(view.container).map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
    ]);
    view.unmount();
  });

  it('paints in ROLE tokens and never in a hue', () => {
    // The rule the design system exists for. A literal colour here is invisible
    // in review and wrong in exactly one theme.
    const values = rulesMentioning('sh-ui-tab')
      .flatMap((rule) => [...rule.style].map((property) => rule.style.getPropertyValue(property)))
      .join(' ');
    expect(values).not.toMatch(/#[0-9a-f]{3,8}\b|\brgb|\bhsl|\boklch/i);
    expect(values).toContain('var(--sh-accent)');
  });

  it('declares its height exactly once', () => {
    // `Row`'s invariant, for the same reason: a strip that grew a taller state
    // would move the panes under it, and one rule is what keeps the band on the
    // app's single vertical rhythm.
    const heights = rulesMentioning('sh-ui-tabs').filter(
      (rule) =>
        rule.style.getPropertyValue('height') !== '' ||
        rule.style.getPropertyValue('min-height') !== '' ||
        rule.style.getPropertyValue('max-height') !== '',
    );
    expect(heights).toHaveLength(1);
    expect(heights[0]?.style.getPropertyValue('height')).toBe('var(--sh-row-height)');
  });
});
