// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { PaneKeys } from './pane-keys.ts';
import type { ViewContributionDTO } from '../shared/index.ts';

const scratch: ViewContributionDTO = {
  extension: 'shepherd.scratch',
  type: 'scratch.pad',
  kind: 'component',
  component: 'scratch.pad',
  surface: 'pane',
  key: 'CmdOrCtrl+Shift+N',
  command: 'scratch.create',
};

function mount(views: readonly ViewContributionDTO[]) {
  const invoke = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<PaneKeys views={views} invoke={invoke} />));
  return { invoke, root };
}

const press = (init: KeyboardEventInit): void => {
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })));
};

describe('PaneKeys', () => {
  it('invokes the declared command when the accelerator matches', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).toHaveBeenCalledWith('scratch.create');
  });

  it('accepts control as well as command, because CmdOrCtrl means either', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n', ctrlKey: true, shiftKey: true });
    expect(invoke).toHaveBeenCalledWith('scratch.create');
  });

  it('ignores the key without shift', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n', metaKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores a bare letter, which is a letter somebody is typing', () => {
    const { invoke } = mount([scratch]);
    press({ key: 'n' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores a pane contribution with a key but NO command', () => {
    // Half a declaration must do nothing rather than something surprising.
    const { invoke } = mount([{ ...scratch, command: undefined }]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores an OVERLAY contribution, which view-overlay.tsx owns', () => {
    // Two handlers on one key would raise the overlay AND run the command.
    const { invoke } = mount([{ ...scratch, surface: 'overlay' }]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores a dock contribution', () => {
    const { invoke } = mount([{ ...scratch, surface: 'dock' }]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const { invoke, root } = mount([scratch]);
    act(() => root.unmount());
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('binds nothing at all when no pane declares a key', () => {
    const { invoke } = mount([]);
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});
