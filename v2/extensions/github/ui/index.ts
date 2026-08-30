/**
 * The UI half — the only thing the renderer may import from this package
 * (`boundaries.js`), because `.` is the service half and runs in a utility
 * process with no DOM.
 */
export { ReviewPane } from './review.tsx';
export { HandMenu, handMenuItems, MENU_MAX, HAND_COPY, HAND_MORE, HAND_NEW_AGENT, type AgentChoice } from './hand-menu.tsx';
export { agoText, readPr, readReview, type ReviewData } from './review-data.ts';
/**
 * Exported for one test, and that is the point of exporting it: these numbers
 * restate `review-pane.css`, which lives in another package, and the drift
 * between the two is a shipped defect (`diff-metrics.css.test.ts`).
 */
export { SHEPHERD_DIFF_SIZING } from './diff-theme.ts';
export { TaskDiffFace } from './task-diff.tsx';
