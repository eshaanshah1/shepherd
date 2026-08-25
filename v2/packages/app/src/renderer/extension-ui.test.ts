import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PANE_UI,
  resolveExtensionPaneUi,
  resolveExtensionRowUi,
} from './extension-ui.ts';

/**
 * A persisted `view` on disk names a REGISTERED TYPE, and the renderer resolves
 * that contribution's `component` against this table (ADR 0044). A name missing
 * from it draws "waiting for whoever draws this" forever — in a pane that is
 * focusable, closable and in the tab strip, so the failure looks like a broken
 * feature rather than a missing registration.
 */
describe('EXTENSION_PANE_UI', () => {
  it('resolves every pane component a built-in registers', () => {
    for (const type of ['editor.workspace', 'github.review', 'scratch.pad']) {
      expect(EXTENSION_PANE_UI[type], type).toBeDefined();
      expect(resolveExtensionPaneUi(type), type).toBeDefined();
    }
  });

  it('resolves nothing for a name no extension contributed', () => {
    expect(resolveExtensionPaneUi('nobody.pane')).toBeUndefined();
    expect(resolveExtensionPaneUi(undefined)).toBeUndefined();
  });

  /*
   * Three tables, not one, because the props differ (ADR 0044). A pane
   * component in the row table would be handed `item`/`selected` and none of
   * the `state`/`focused` it exists to read.
   */
  it('keeps pane components out of the row table', () => {
    expect(resolveExtensionRowUi('editor.workspace')).toBeUndefined();
  });
});
