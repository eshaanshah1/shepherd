// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '@pierre/trees';
import './jsdom-gaps.ts';
import { EditorPane } from './editor-pane.tsx';

/**
 * What the pane DOES once mounted — the half no test of a pure function can see.
 *
 * This file exists because of a bug all 114 other tests passed through:
 * `editor.tree` answered 829 paths and the rail drew nothing. Every pure
 * function was right. What was wrong is that `useFileTree` is
 * `useState(() => new FileTree(options))` — **the options are read once, at
 * construction** — and this pane's paths arrive from a command a tick after
 * mount, so the model was built empty and stayed empty. `tree-model.test.ts`
 * pins that package behaviour; this file pins that the pane answers it.
 *
 * The assertions are on the MODEL rather than on rendered rows, because the
 * tree virtualises: jsdom reports every element as zero-height, so no row is
 * ever inside the viewport and the shadow root holds a stylesheet and nothing
 * else. A DOM assertion here would fail whether the pane were right or wrong,
 * which is worse than no assertion at all.
 */

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
  vi.restoreAllMocks();
});

const TREE = {
  paths: ['.env', 'README.md', 'src/app.ts'],
  status: [{ path: 'src/app.ts', status: 'modified' }],
  truncated: false,
  notes: [],
};

/** A pane `invoke` that answers on a microtask, as the real port does. */
function invoker(answers: Record<string, unknown>) {
  const calls: { command: string; args: unknown }[] = [];
  const invoke = async (command: string, args?: unknown) => {
    calls.push({ command, args });
    return { ok: true as const, value: answers[command] };
  };
  return { invoke, calls };
}

async function mount(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  // A second flush: the tree arrives from a promise, so the render that shows
  // it is a tick after the one that mounted.
  await act(async () => {});
}

const pane = (state: unknown, invoke: ReturnType<typeof invoker>['invoke']): React.ReactElement => (
  <EditorPane state={state} focused paneId="p1" invoke={invoke} done={() => {}} />
);

describe('the editor pane', () => {
  it('puts the answered paths INTO the tree model', async () => {
    // The regression this file was written for.
    const reset = vi.spyOn(FileTree.prototype, 'resetPaths');
    const { invoke } = invoker({ 'editor.tree': TREE });
    await mount(pane({ root: '/repo' }, invoke));

    const last = reset.mock.calls.at(-1)?.[0];
    expect(last).toEqual(['.env', 'README.md', 'src/app.ts']);
    // The ignored file is the whole point of the listing rule, and it must
    // survive all the way to the thing that draws it.
    expect(last).toContain('.env');
  });

  it('asks for the tree of the root it was opened on', async () => {
    const { invoke, calls } = invoker({ 'editor.tree': TREE });
    await mount(pane({ root: '/repo' }, invoke));
    expect(calls.find((call) => call.command === 'editor.tree')?.args).toEqual({ root: '/repo' });
  });

  it('hands the marks to the tree, rather than drawing its own', async () => {
    const status = vi.spyOn(FileTree.prototype, 'setGitStatus');
    const { invoke } = invoker({ 'editor.tree': TREE });
    await mount(pane({ root: '/repo' }, invoke));
    expect(status.mock.calls.at(-1)?.[0]).toEqual([{ path: 'src/app.ts', status: 'modified' }]);
  });


  it('says so, rather than drawing nothing, when the pane has no root', async () => {
    const { invoke } = invoker({});
    await mount(pane({}, invoke));
    expect(host.textContent).toContain('no directory');
  });

  it('announces a truncated listing instead of showing a partial tree in silence', async () => {
    const { invoke } = invoker({ 'editor.tree': { ...TREE, truncated: true } });
    await mount(pane({ root: '/repo' }, invoke));
    expect(host.textContent).toContain('Too many files');
  });
});
