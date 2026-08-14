import type { CheckRun, PullRequest, ReviewThread } from './pr.ts';

/**
 * What "Hand to agent" actually says.
 *
 * Pure, and worth its own file, because it is the one output of this extension
 * that another program reads: everything else is drawn for a person and can be
 * approximately right. A prompt is an instruction, and the difference between
 * naming the check and describing it is the difference between an agent that
 * fixes the build and one that asks which build.
 *
 * Three rules it follows throughout:
 *
 *   - **State the fact, then the task.** The agent is already in the worktree
 *     and already has the code; what it does not have is what GitHub knows.
 *   - **Quote rather than summarise.** A check's own output and a reviewer's own
 *     words are the evidence; a paraphrase is a second chance to be wrong.
 *   - **Never say "please" and never apologise.** It is a work item.
 */

/** A failing check, handed over. */
export function checkPrompt(pr: PullRequest, check: CheckRun): string {
  const lines = [
    `The \`${check.name}\` check is failing on ${pr.repo}#${pr.number} (${pr.headRef}).`,
    '',
  ];
  if (check.summary !== undefined) {
    lines.push('What it reported:', '', '```', check.summary, '```', '');
  }
  lines.push(
    'Find the cause in this worktree, fix it, and run the same check locally to confirm.',
    'If the fix is not obvious, say what you found rather than guessing.',
  );
  return lines.join('\n');
}

/**
 * One review thread, handed over.
 *
 * The location is given as `path:line` rather than as a link, because the agent
 * has the file and does not have a browser. A thread whose line has gone
 * (`line: null`) says so instead of inventing one — the comment is still worth
 * addressing, and a fabricated line number would send the agent to the wrong
 * place with confidence.
 */
export function threadPrompt(pr: PullRequest, thread: ReviewThread): string {
  const at = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  const where = thread.path === '' ? 'this pull request' : at;
  return [
    `@${thread.author} left a review comment on ${where} in ${pr.repo}#${pr.number}:`,
    '',
    '```',
    thread.body,
    '```',
    '',
    'Address it in this worktree. If you disagree with the comment, do not change the code —',
    'say why, so it can be replied to.',
  ].join('\n');
}

/**
 * Every unresolved thread at once — the whole review, handed over.
 *
 * A separate function rather than a loop over `threadPrompt`, because N prompts
 * would be N agents: `tasks.spawn` opens one pane per call, and a PR with six
 * comments would fill the task with six sessions each holding one sentence.
 */
export function reviewPrompt(pr: PullRequest): string | null {
  const open = pr.threads.filter((thread) => !thread.resolved);
  if (open.length === 0) return null;
  const body = open.map((thread, index) => {
    const at = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
    return [`${index + 1}. @${thread.author} on ${at}:`, '', '```', thread.body, '```'].join('\n');
  });
  return [
    `${open.length} unresolved review ${open.length === 1 ? 'comment' : 'comments'} on ${pr.repo}#${pr.number}:`,
    '',
    ...body,
    '',
    'Address them in this worktree, in order. For any you disagree with, leave the code alone',
    'and say why.',
  ].join('\n');
}
