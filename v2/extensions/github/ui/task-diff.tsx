import type { ReactElement } from 'react';
import type { ExtensionFaceProps } from '@shepherd/sdk';
import { ReviewPane } from './review.tsx';

/**
 * The **Changes** face of a task (ADR 0051): what it changed, and where that is
 * in review.
 *
 * It began as the working changes alone, and that was half an answer. The other
 * half — the pull request carrying the work, its checks, its review threads —
 * lived in a PANE you opened as a tab, so a task had two surfaces for one idea
 * and you had to know which one held which fact. "What did this task do, and
 * where is it in review" is ONE question and it now has one place.
 *
 * So this renders the review surface itself rather than a subset of it.
 * `ReviewPane` already draws the working changes when no pull request is open
 * (`WorkingChanges`, on its home page), which is why there is nothing to merge:
 * the richer surface was always the superset, and the face was drawing the
 * poorer one beside it.
 *
 * A face has no pane, so nothing here passes `paneId` or `state` from a leaf.
 * The subject arrives as `task` because the window is already showing it, and
 * `ReviewSurfaceProps` is the three props the component actually reads — see
 * ADR 0051 for why a face could not simply borrow the pane's contract.
 */
export function TaskDiffFace({ task, invoke }: ExtensionFaceProps): ReactElement {
  /*
   * `focused` is TRUE, and it is not a lie by omission: a face is the whole body
   * of the window while it is up, so there is no sibling for a keystroke to
   * belong to instead. `ExtensionFaceProps` deliberately carries no such flag —
   * this is the one place the constant is written down.
   */
  return <ReviewPane state={{ task: task.id }} focused invoke={invoke} />;
}
