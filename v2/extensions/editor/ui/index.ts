/**
 * The UI half, imported ONLY by the renderer (`boundaries.js`).
 *
 * `EditorPane` is what `EXTENSION_PANE_UI` resolves `editor.workspace` to
 * (ADR 0044); everything else here is exported for the tests.
 */
export { EditorPane, readEditorState, readTree } from './editor-pane.tsx';
export { FileEditor, saveOutcome, saveNote, readDoc } from './file-editor.tsx';
