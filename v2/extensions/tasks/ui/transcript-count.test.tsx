// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeItem } from '@shepherd/sdk';
import { TranscriptCountRow } from './transcript-count.tsx';

/**
 * What the count row DRAWS, and what clicking it does.
 *
 * The click is the part no other test can reach: the row raises the overlay by
 * dispatching a window event, because a `TreeItem.command` is invoked in the
 * extension host and the modal layer lives in the renderer. If that event ever
 * stops firing, the rail reports `12 in transcripts` and clicking it does
 * nothing — which looks exactly like a broken search rather than a broken row.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let raised: unknown[];
let listener: (event: Event) => void;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  raised = [];
  listener = (event) => {
    raised.push((event as CustomEvent).detail);
  };
  window.addEventListener('sh:raise-view', listener);
});

afterEach(() => {
  window.removeEventListener('sh:raise-view', listener);
  act(() => {
    root.unmount();
  });
  host.remove();
});

const draw = (data: unknown): void => {
  const item = { id: 'transcripts', label: 'n in transcripts', data } as TreeItem;
  act(() => {
    root.render(
      <TranscriptCountRow
        item={item}
        selected={false}
        invoke={async () => ({ ok: true, value: undefined })}
      />,
    );
  });
};

const row = (): HTMLElement | null => host.querySelector('[role="button"]');

describe('the transcript count row', () => {
  it('states the count', () => {
    draw({ total: 12 });
    expect(row()?.textContent).toContain('12 in transcripts');
  });

  it('raises the session-search view when clicked', () => {
    draw({ total: 3 });
    act(() => {
      row()?.click();
    });
    expect(raised).toEqual(['tasks.sessionSearch']);
  });

  it('is reachable by keyboard', () => {
    draw({ total: 3 });
    expect(row()?.getAttribute('tabindex')).toBe('0');
    act(() => {
      row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(raised).toEqual(['tasks.sessionSearch']);
  });

  it('shows the shortcut, so the keyboard path is discoverable', () => {
    draw({ total: 3 });
    expect(host.textContent).toContain('⇧⌘F');
  });

  it('draws nothing at all for a zero count', () => {
    draw({ total: 0 });
    expect(host.firstChild).toBeNull();
  });

  it('draws nothing when handed data of the wrong shape', () => {
    draw({ nope: true });
    expect(host.firstChild).toBeNull();
  });

  it('draws nothing when handed no data at all', () => {
    draw(undefined);
    expect(host.firstChild).toBeNull();
  });
});
