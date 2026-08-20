/**
 * The UI half — the only thing the renderer may import from this package
 * (`boundaries.js`), because `.` is the service half and runs in a utility
 * process with no DOM.
 */
export { ScratchPane, SAVE_DEBOUNCE_MS, readScratchId, wordCount } from './scratch-pane.tsx';
