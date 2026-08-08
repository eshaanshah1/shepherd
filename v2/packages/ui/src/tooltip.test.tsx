import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { TOOLTIP_DELAY_MS, Tooltip } from './tooltip.tsx';
import { Button } from './button.tsx';
import './styles.css';

const tip = (): HTMLElement | null => document.querySelector<HTMLElement>('.sh-ui-tooltip');

describe('Tooltip', () => {
  it('renders its trigger and nothing else while closed', () => {
    const dom = mount(
      <Tooltip content="Working — 3 tools">
        <Button>Trigger</Button>
      </Tooltip>,
    );
    expect(dom.container.querySelector('.sh-ui-button')?.textContent).toBe('Trigger');
    expect(tip()).toBeNull();
    dom.unmount();
  });

  it('renders its content when open', () => {
    const dom = mount(
      <Tooltip content="Working — 3 tools" open>
        <Button>Trigger</Button>
      </Tooltip>,
    );
    expect(tip()?.textContent).toBe('Working — 3 tools');
    dom.unmount();
  });

  it('describes its trigger rather than naming it', () => {
    // The word that used to be in the row. A tooltip is a DESCRIPTION — naming
    // the trigger with it would replace the button's own label with a sentence.
    const dom = mount(
      <Tooltip content="Working" open>
        <Button>Trigger</Button>
      </Tooltip>,
    );
    const trigger = dom.container.querySelector('.sh-ui-button');
    expect(trigger?.getAttribute('aria-describedby')).toBeTruthy();
    dom.unmount();
  });

  it('merges onto the caller-s element rather than wrapping it', () => {
    // `asChild` on the trigger: a wrapper span would break the flex row the
    // trigger sits in and change what a sibling selector matches.
    const dom = mount(
      <Tooltip content="Working" open>
        <Button data-testid="pane-state">Trigger</Button>
      </Tooltip>,
    );
    const trigger = dom.container.querySelector('[data-testid="pane-state"]');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.className).toContain('sh-ui-button');
    dom.unmount();
  });

  it('opens after a 400ms rest, not the 200ms default', () => {
    // Long enough that running the pointer down a list does not strobe a tooltip
    // at every row — which is the failure mode of the default in a UI that is
    // mostly list.
    expect(TOOLTIP_DELAY_MS).toBe(400);
  });

  it('draws no arrow and takes no clicks', () => {
    const rule = rulesMentioning('sh-ui-tooltip')[0];
    expect(rule?.style.getPropertyValue('pointer-events')).toBe('none');
    // An arrow would be a second shape to keep on the hairline grid at every
    // collision-flipped side, and it says nothing the position does not.
    expect(document.querySelector('.sh-ui-tooltip-arrow')).toBeNull();
  });

  it('sets no position of its own, so Radix-s collision handling still works', () => {
    const rule = rulesMentioning('sh-ui-tooltip')[0];
    expect(rule?.style.getPropertyValue('position')).toBe('');
    expect(rule?.style.getPropertyValue('transform')).toBe('');
  });
});
