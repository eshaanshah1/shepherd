// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { IconGitPullRequest, IconPlus } from '@tabler/icons-react';
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
    expect(values).toContain('var(--sh-fill-tab)');
    // And NOT `sky`. The active tab used to take a sky underline; that colour
    // has one job — "live · focus · send" — which a tab that merely happens to
    // be the one you are on is none of. It also collided with the mark a tab
    // carries for the agent inside it: a blue rule under a blue working meter.
    expect(values).not.toContain('var(--sh-sky)');
  });

  it('draws a mark only for a tab that has one, and keeps the slot on the rest', () => {
    // A tab with no agent has no state to be in, so it claims none. It keeps the
    // 12px, though: a tab that widened when its agent started would shove every
    // tab to its right along, which is a control moving under the cursor.
    const view = mount(
      <TabStrip
        tabs={[
          { id: 'a', label: 'api' },
          { id: 'b', label: 'logs', mark: 'waiting' },
        ]}
        activeId="a"
        onSelect={() => {}}
      />,
    );
    const marks = tabs(view.container).map((tab) => tab.querySelector('.sh-ui-mark'));
    expect(marks[0]).not.toBeNull();
    expect(marks[0]?.getAttribute('data-state')).toBeNull();
    expect(marks[1]?.getAttribute('data-state')).toBe('waiting');
    view.unmount();
  });

  it('says nothing about a stateless tab, in the DOM as well as on screen', () => {
    // The empty slot is spacing, not a sixth state. It must not reach a screen
    // reader as one — `StateMark` puts its word in the DOM, and this has none.
    const view = mount(
      <TabStrip tabs={[{ id: 'a', label: 'zsh' }]} activeId="a" onSelect={() => {}} />,
    );
    expect(tabs(view.container)[0]?.textContent).toBe('zsh');
    view.unmount();
  });

  it('draws a tab’s own glyph in the slot when it has no state to report', () => {
    // A review tab is not an agent and has no lifecycle, so what it has to say
    // is what it IS.
    const view = mount(
      <TabStrip
        tabs={[{ id: 'a', label: 'review', icon: IconGitPullRequest }]}
        activeId="a"
        onSelect={() => {}}
      />,
    );
    expect(tabs(view.container)[0]?.querySelector('.sh-ui-mark svg')).not.toBeNull();
    view.unmount();
  });

  it('lets the agent’s state beat the tab’s glyph, never the other way round', () => {
    // One leading slot. A glyph displacing a blocked square would hide the one
    // thing in the strip you can act on.
    const view = mount(
      <TabStrip
        tabs={[{ id: 'a', label: 'review', icon: IconGitPullRequest, mark: 'waiting' }]}
        activeId="a"
        onSelect={() => {}}
      />,
    );
    const slot = tabs(view.container)[0]?.querySelector('.sh-ui-mark');
    expect(slot?.getAttribute('data-state')).toBe('waiting');
    expect(slot?.querySelector('svg')).toBeNull();
    view.unmount();
  });

  it('draws a mark for a quiet agent as readily as a loud one', () => {
    // The strip reports the pane you are NOT looking at. A tab that drew nothing
    // while its agent worked made 'working' and 'no agent here' one picture.
    const view = mount(
      <TabStrip
        tabs={[
          { id: 'a', label: 'api', mark: 'working' },
          { id: 'b', label: 'logs', mark: 'resting' },
        ]}
        activeId="a"
        onSelect={() => {}}
      />,
    );
    expect(tabs(view.container).map((tab) => tab.querySelector('.sh-ui-mark')?.getAttribute('data-state'))).toEqual([
      'working',
      'resting',
    ]);
    view.unmount();
  });

  it('puts every mark’s word in the DOM', () => {
    // Two states are a hue apart and nothing else. A fact encoded only in colour
    // cannot be read out, searched, or asserted on.
    const view = mount(
      <TabStrip
        tabs={[
          { id: 'a', label: 'api', mark: 'failed' },
          { id: 'b', label: 'logs', mark: 'ready' },
        ]}
        activeId="a"
        onSelect={() => {}}
      />,
    );
    expect(tabs(view.container).map((tab) => tab.textContent)).toEqual([
      'Failedapi',
      'Ready for youlogs',
    ]);
    view.unmount();
  });

  it('declares its height exactly once', () => {
    // `Row`'s invariant, for the same reason: a strip that grew a taller state
    // would move the panes under it, and one rule is what keeps the band on the
    // app's single vertical rhythm.
    //
    // The BAND, which is why the sub-element selectors are filtered out rather
    // than swept in: a control inside the strip has a control's height and is not
    // a second opinion about how tall the band is. `__` is the whole test for
    // that — every child of this component is named for it.
    const heights = rulesMentioning('sh-ui-tabs').filter(
      (rule) =>
        !rule.selectorText.includes('__') &&
        (rule.style.getPropertyValue('height') !== '' ||
          rule.style.getPropertyValue('min-height') !== '' ||
          rule.style.getPropertyValue('max-height') !== ''),
    );
    expect(heights).toHaveLength(1);
    // A fixed BAND, not the row rhythm: the row grew to 34 with the task card,
    // and the strip is furniture rather than a list.
    expect(heights[0]?.style.getPropertyValue('height')).toBe('var(--sh-band-tab-strip)');
  });
});

/**
 * The focused pane's actions, at the trailing edge.
 *
 * What these assert is the contract and the ordering: an id and a PART come back
 * rather than a callback per half, the actions draw before the strip's own verb,
 * and a strip with none is byte-for-byte the strip that existed before them.
 */
describe('TabStrip — pane actions', () => {
  const INSTALL = { id: 'install', label: 'Install skill', glyph: IconGitPullRequest };

  it('draws nothing extra when there are none', () => {
    const view = mount(<TabStrip tabs={TABS} activeId="a" onSelect={() => {}} />);
    expect(view.container.querySelector('.sh-ui-tabs__action')).toBeNull();
    expect(view.container.querySelector('.sh-ui-tabs__trailing')).toBeNull();
    view.unmount();
  });

  it('reports the id that was clicked', () => {
    const hits: string[] = [];
    const view = mount(
      <TabStrip
        tabs={TABS}
        activeId="a"
        onSelect={() => {}}
        actions={[INSTALL]}
        onAction={(id) => hits.push(id)}
      />,
    );
    act(() => {
      view.container.querySelector<HTMLElement>('[data-testid="tab-action-install"]')?.click();
    });
    expect(hits).toEqual(['install']);
    view.unmount();
  });

  it('labels the action in text, not by its glyph alone', () => {
    const view = mount(
      <TabStrip tabs={TABS} activeId="a" onSelect={() => {}} actions={[INSTALL]} onAction={() => {}} />,
    );
    expect(view.container.querySelector('[data-testid="tab-action-install"]')?.textContent).toBe('Install skill');
    view.unmount();
  });

  it('draws actions BEFORE the strip’s own verb', () => {
    const view = mount(
      <TabStrip
        tabs={TABS}
        activeId="a"
        onSelect={() => {}}
        onNew={() => {}}
        newIcon={IconPlus}
        actions={[INSTALL]}
      />,
    );
    const trailing = view.container.querySelector('.sh-ui-tabs__trailing');
    const drawn = [...(trailing?.children ?? [])].map((child) => child.getAttribute('data-testid'));
    expect(drawn).toEqual(['tab-action-install', 'tab-new']);
    view.unmount();
  });

  it('still draws the new-tab control with no actions beside it', () => {
    const view = mount(
      <TabStrip tabs={TABS} activeId="a" onSelect={() => {}} onNew={() => {}} newIcon={IconPlus} />,
    );
    expect(newTab(view.container)).not.toBeNull();
    view.unmount();
  });

  /*
   * ONE element holds the edge. With the auto margin on the `+`, an action
   * appearing beside it would shove the `+` along — which is §10's control that
   * moves under the cursor, on the gesture that makes it happen.
   */
  it('holds the trailing edge in one place, not per control', () => {
    const pinned = rulesMentioning('sh-ui-tabs').filter(
      (rule) => rule.style.getPropertyValue('margin-inline-start') === 'auto',
    );
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.selectorText).toContain('__trailing');
  });

  /*
   * The control's drawn height is the small control token, once. The
   * coarse-pointer target is excluded because it is neither drawn nor in layout —
   * `button.css` calls 44px a device fact rather than a design value, and it is
   * the one literal length either file is allowed.
   */
  it('draws the control at one height, and it is the small control token', () => {
    const heights = rulesMentioning('sh-ui-tabs__action').filter(
      (rule) => rule.style.getPropertyValue('height') !== '' && !rule.selectorText.includes('::after'),
    );
    expect(heights).toHaveLength(1);
    expect(heights[0]?.style.getPropertyValue('height')).toBe('var(--sh-control-sm)');
  });

  /*
   * Secondary, never primary: `wool` is the one loud fill on a surface and a
   * strip already has three tabs on it. The assertion is that nothing here
   * declares a resting background at all — hover is what adds one.
   */
  it('rests with no fill of its own', () => {
    const resting = rulesMentioning('sh-ui-tabs__action').filter(
      (rule) => !rule.selectorText.includes(':') && rule.style.getPropertyValue('background') !== '',
    );
    expect(resting).toHaveLength(1);
    expect(resting[0]?.style.getPropertyValue('background')).toBe('transparent');
  });
});
