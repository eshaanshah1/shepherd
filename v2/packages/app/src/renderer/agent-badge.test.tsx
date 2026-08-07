// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { mount } from './test-dom.ts';
import { AgentBadge } from './agent-badge.tsx';

describe('AgentBadge', () => {
  it('renders the slot even for a plain shell', () => {
    // The slot is unconditional so the terminal host keeps a fixed position in
    // its parent's children. An empty `data-agent-state` also lets a smoke tell
    // "no agent" from "the channel never delivered" — identical pixels, very
    // different bugs.
    const dom = mount(<AgentBadge />);
    const badge = dom.container.querySelector('[data-testid="agent-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-agent-state')).toBe('');
    expect(badge?.textContent).toBe('');
  });

  it('names the state and carries its reason', () => {
    const dom = mount(<AgentBadge state="blocked" reason="approve Bash" />);
    const badge = dom.container.querySelector('[data-testid="agent-badge"]');
    expect(badge?.getAttribute('data-agent-state')).toBe('blocked');
    expect(badge?.textContent).toContain('blocked');
    expect(badge?.textContent).toContain('approve Bash');
  });

  it('reads needsCheck as done, in pasture', () => {
    // Flock rule 8: grazing = done, waiting for you. The word and the colour are
    // the token's declared job, not a local choice.
    const dom = mount(<AgentBadge state="needsCheck" />);
    expect(dom.container.querySelector('.sh-agent-label')?.textContent).toBe('done');
    expect(dom.container.querySelector('.sh-agent-dot')?.getAttribute('style')).toContain('--sh-pasture');
  });

  it('treats an unknown state as no agent rather than inventing a label', () => {
    const dom = mount(<AgentBadge state="something-new" />);
    expect(dom.container.querySelector('[data-testid="agent-badge"]')?.getAttribute('data-agent-state')).toBe('');
  });
});

describe('the remount trap — what actually remounts a sibling', () => {
  const Term = (): ReactNode => <div data-testid="terminal-host" />;
  const hostOf = (d: ReturnType<typeof mount>): Element | null =>
    d.container.querySelector('[data-testid="terminal-host"]');

  it('CONTROL: a conditional WRAPPER remounts the terminal', () => {
    // The negative control, without which every assertion below could be
    // passing for the wrong reason. This is the v1 `_ConditionalContent` shape:
    // the element at that position changes type, so React tears the subtree down
    // and builds a new one — a fresh xterm, and the pane's scrollback is gone.
    const Bad = ({ on }: { on: boolean }): ReactNode =>
      on ? <div className="wrap"><Term /></div> : <Term />;
    const dom = mount(<Bad on={false} />);
    const before = hostOf(dom);
    dom.rerender(<Bad on={true} />);
    expect(hostOf(dom), 'the control did not remount, so it controls nothing').not.toBe(before);
  });

  it('CONTROL: positional keys in a list that grows remount the terminal', () => {
    // The second real shape, and the easier one to write by accident: `key={i}`
    // over a list that gains an element at the front re-associates every key
    // with a different child.
    const Bad = ({ on }: { on: boolean }): ReactNode => (
      <div>
        {(on ? [<span key="x" />, <Term key="t" />] : [<Term key="t" />]).map((node, i) => (
          <div key={i}>{node}</div>
        ))}
      </div>
    );
    const dom = mount(<Bad on={false} />);
    const before = hostOf(dom);
    dom.rerender(<Bad on={true} />);
    expect(hostOf(dom), 'the control did not remount, so it controls nothing').not.toBe(before);
  });

  it('the badge beside a terminal keeps the terminal mounted', () => {
    // The shape this component actually uses. It survives — and, measured, so
    // would a conditional sibling; the unconditional slot is here for the smoke
    // and for CSS, not for this. Kept as a regression pin: the day somebody
    // wraps the host to add a border, the controls above say what broke.
    const Pane = ({ state }: { state?: string }): ReactNode => (
      <div className="sh-pane">
        <AgentBadge {...(state === undefined ? {} : { state })} />
        <Term />
      </div>
    );
    const dom = mount(<Pane />);
    const before = hostOf(dom);
    dom.rerender(<Pane state="working" />);
    expect(hostOf(dom), 'the terminal host was remounted when the agent appeared').toBe(before);
  });
});
