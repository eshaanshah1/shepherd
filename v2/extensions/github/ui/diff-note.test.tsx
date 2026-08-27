// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffNote } from './pr-panels.tsx';
import type { ReviewThread } from '../src/model/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'T1',
  author: 'eshaanshah-bs',
  at: 0,
  path: 'stack/dev/jira_state.md',
  line: 61,
  side: 'right',
  resolved: false,
  body: '**[Low] "Three consequences" now has four bullets**\n\nThis new `stack:dev` label bullet is the fourth under that heading.',
  ...over,
});

const draw = (over: Partial<ReviewThread> = {}): void => {
  act(() =>
    root.render(
      <DiffNote
        thread={thread(over)}
        adrift={false}
        busy={false}
        wrapHand={(_at, button) => button}
        onHandThread={() => undefined}
      />,
    ),
  );
};

describe('a review comment in the diff', () => {
  it('renders its markdown, rather than showing you the source', () => {
    /*
     * A reviewer writes markdown, and this drew `thread.body` as a text node —
     * so a comment opening with a bold severity tag arrived as literal asterisks
     * and its inline code arrived wearing backticks.
     */
    draw();
    expect(host.querySelector('strong')?.textContent).toBe('[Low] "Three consequences" now has four bullets');
    expect(host.querySelector('code')?.textContent).toBe('stack:dev');
    expect(host.textContent).not.toContain('**');
    expect(host.textContent).not.toContain('`');
  });

  it('shows the whole comment, not the first line of it', () => {
    // It was `white-space: nowrap` with an ellipsis, which told you a comment
    // existed and then refused to show it — on the one surface that exists to
    // get a reviewer's words in front of you.
    draw();
    expect(host.textContent).toContain('the fourth under that heading');
    expect(host.querySelectorAll('.sh-pr-diff__note-body p')).toHaveLength(2);
  });

  it('keeps the author and the hand-off out of the prose', () => {
    // The byline is a row of its own now: with a multi-line body they cannot
    // share a line, and a button that moved down as a comment grew would land
    // somewhere different on every note.
    draw();
    expect(host.querySelector('.sh-pr-diff__note-who')?.textContent).toContain('eshaanshah-bs');
    expect(host.querySelector('.sh-pr-diff__note-body')?.textContent).not.toContain('eshaanshah-bs');
  });
});
