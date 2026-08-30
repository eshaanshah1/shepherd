/**
 * The UI half's barrel — the only thing the renderer imports from this
 * extension (`boundaries.js` permits an extension's `ui` directory and nothing else).
 *
 * It exists because there are now two contributed components and the subpath
 * used to point straight at one file. A barrel rather than two subpaths so the
 * boundary rule stays one line.
 */
export { TaskComposer } from './composer.tsx';
export { TaskCard } from './task-card.tsx';
export { TranscriptCountRow } from './transcript-count.tsx';
export { SessionSearchView } from './session-search.tsx';
export { readCardData, type CardData, type CardMark, type CardQuestion, type CardRepo } from './card-data.ts';
export { TaskIntentFace } from './intent.tsx';
