/**
 * The UI half — the only thing the renderer may import from this package
 * (`boundaries.js`), because `.` is the service half and runs in a utility
 * process with no DOM.
 */
export { ReviewPane } from './review.tsx';
export { HandMenu, handMenuItems, MENU_MAX, HAND_COPY, HAND_MORE, HAND_NEW_AGENT, type AgentChoice } from './hand-menu.tsx';
export { agoText, readPr, readReview, type ReviewData } from './review-data.ts';
