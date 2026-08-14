/**
 * What a pull request IS to this app, and every decision about how it reads.
 *
 * Pure and separate from the client for the reason `tasks/model/` is separate
 * from its store: the questions here — which PR is worst, what does this row
 * say, what order do these land in — are the ones with edge cases, and they are
 * answerable without a network, a token or a clock. `src/api.ts` turns GitHub's
 * shapes into these; nothing below knows GitHub's field names.
 *
 * **Nothing here reads a clock.** Anything about elapsed time takes `now`, so a
 * test states the case instead of mocking one — the same rule
 * `tasks/model/shipped-days.ts` writes down.
 */

/**
 * The four states a PR is in, and no fifth.
 *
 * `draft` is a separate value rather than a flag on `open`, because everywhere
 * it is read it is read INSTEAD of open — a draft's checks are not a reason to
 * act, its missing review is not a gap, and it is not part of what can land. A
 * boolean beside `open` would make every one of those an `&& !isDraft`.
 */
export type PrState = 'draft' | 'open' | 'merged' | 'closed';

/** How a check ended, reduced from the several vocabularies GitHub uses. */
export type CheckState = 'passed' | 'failed' | 'running' | 'skipped';

export interface CheckRun {
  readonly name: string;
  readonly state: CheckState;
  /** How long it took. Absent for one that has not finished. */
  readonly durationMs?: number;
  /**
   * The one line worth reading when it failed — `2 errors`, a file and a
   * position, the message. Absent when GitHub had nothing but a red tick.
   */
  readonly summary?: string;
  /**
   * The check's own output, as text — what the Checks tab draws instead of
   * sending you to a browser.
   *
   * This is the tab where an ADE beats the website: the failing lines are on
   * screen and the fix is one keystroke from them, rather than a copy-paste out
   * of a browser into a terminal. GitHub caps it at 64KB; most are a few lines.
   */
  readonly log?: string;
  /** Where the full log is. A URL the pane opens; never fetched. */
  readonly url?: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly author: string;
  readonly path: string;
  readonly line: number | null;
  /**
   * Which side of the diff the line is on — `right` for the new file, `left`
   * for the old.
   *
   * Read rather than assumed, because assuming puts a comment about a REMOVED
   * line beside the addition that replaced it: a remark about the code that went
   * away, attached to the code that arrived. GitHub records it; there is no
   * reason to guess.
   */
  readonly side: 'left' | 'right';
  readonly resolved: boolean;
  readonly body: string;
  /**
   * Resolved by whoever the agent is, rather than by a person.
   *
   * A guess, and labelled as one where it is drawn (`resolved by the agent`):
   * GitHub records who resolved a thread and not what resolved it. It is worth
   * making because the two readings differ in what you should do next — a
   * thread you closed is done, and one the reviewer closed may still want a
   * reply.
   */
  readonly resolvedByYou?: boolean;
}

export interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /**
   * The unified diff for this file, when it has been fetched.
   *
   * Absent until the Files tab asks: a patch is the largest thing about a PR by
   * an order of magnitude, and fetching one for every PR of every task on a poll
   * would make the sync loop the most expensive thing in the app. It comes from
   * a second request, made once, when somebody looks.
   */
  readonly patch?: string;
}

/** One commit of a PR — what the Commits tab lists. */
export interface Commit {
  readonly sha: string;
  /** The first line. A list is a list; the body is on GitHub. */
  readonly subject: string;
  readonly author: string;
  readonly at: number;
}

/** A reviewer and where they landed — the meta column's first block. */
export interface Reviewer {
  readonly login: string;
  readonly verdict: 'approved' | 'changes' | 'commented';
  /** How many of this PR's threads are theirs. */
  readonly comments: number;
}

export interface PullRequest {
  /** `owner/repo`, as GitHub knows it — what the row's first word is. */
  readonly repo: string;
  /**
   * The TASK's name for the repo this came from (the worktree's basename).
   *
   * Carried alongside `repo` rather than derived from it, because they differ
   * whenever a directory is not named after its remote — and this is the half
   * that joins a PR back to the checkout it belongs to.
   */
  readonly repoKey: string;
  readonly number: number;
  readonly title: string;
  /**
   * The description, as text.
   *
   * Plain rather than markdown, and drawn as a paragraph: rendering markdown
   * would mean a renderer, a sanitiser and a decision about images, for a field
   * most PRs use for two sentences. `Open on GitHub` is one button away.
   */
  readonly body: string;
  readonly state: PrState;
  readonly baseRef: string;
  readonly headRef: string;
  readonly url: string;
  readonly added: number;
  readonly removed: number;
  readonly changedFiles: number;
  readonly checks: readonly CheckRun[];
  /** Logins that approved. */
  readonly approvals: readonly string[];
  /** Logins that asked for changes. */
  readonly changesRequested: readonly string[];
  readonly threads: readonly ReviewThread[];
  /** Populated only for the PR being looked at — the list does not need it. */
  readonly files?: readonly ChangedFile[];
  /** Its commits, newest first. The header counts them; a tab lists them. */
  readonly commits: readonly Commit[];
  /**
   * Every reviewer and where they landed.
   *
   * Kept alongside `approvals`/`changesRequested` rather than replacing them:
   * those two are what the ROW and the rollup read, and they are the reduction
   * this is the detail of. "Is this approved" and "who looked and what did they
   * say" are two questions, not two copies of one.
   */
  readonly reviewers: readonly Reviewer[];
  /** Epoch ms. */
  readonly openedAt: number;
  readonly updatedAt: number;
  /**
   * GitHub's own answer to "can this merge", verbatim-ish: `clean`, `blocked`,
   * `dirty`, `behind`, `unknown`. Reduced rather than trusted — see `canMerge`.
   */
  readonly mergeState: 'clean' | 'blocked' | 'dirty' | 'behind' | 'unknown';
  /**
   * Other PRs this one must land after, as `owner/repo#123`.
   *
   * Read from `Depends-on:` trailers in the body, which is a convention rather
   * than a GitHub feature — so it is a hint that orders a list, never a gate
   * that stops one. Within a repo the base refs say the same thing more
   * reliably and are used instead.
   */
  readonly dependsOn: readonly string[];
}

/** `owner/repo#123` — the identity every cross-reference uses. */
export const prKey = (pr: Pick<PullRequest, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`;

// ------------------------------------------------------------------- checks

export interface CheckCount {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly running: number;
}

/**
 * `skipped` is counted in neither the total nor anything else.
 *
 * It is what a workflow does when its path filter did not match, so counting it
 * would make `12 of 13 checks` the healthy state of a repo whose test job is
 * conditional — a number that is never green is a number nobody reads.
 */
export function countChecks(checks: readonly CheckRun[]): CheckCount {
  const counted = checks.filter((check) => check.state !== 'skipped');
  return {
    total: counted.length,
    passed: counted.filter((check) => check.state === 'passed').length,
    failed: counted.filter((check) => check.state === 'failed').length,
    running: counted.filter((check) => check.state === 'running').length,
  };
}

/** The first failing check, which is the one the pane makes the subject. */
export const firstFailure = (pr: PullRequest): CheckRun | undefined =>
  pr.checks.find((check) => check.state === 'failed');

// -------------------------------------------------------------- what it says

/**
 * How loud a fact is, in words the palette can resolve.
 *
 * Never a colour and never a hex: a contributed surface supplies data and a
 * token NAME (§7). Four tones because the design has four — the failure, the
 * good outcome, the ordinary fact and the thing that is not asking for anything.
 */
export type Tone = 'negative' | 'positive' | 'neutral' | 'quiet';

export interface Said {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * The state, in words, for the row's trailing cell — `typecheck failed`,
 * `approved`, `draft`.
 *
 * ONE phrase, chosen by priority, because the row has one slot and the slot has
 * to hold the thing you would act on. The order is the order you would act in:
 *
 *   1. it is finished (merged / closed) — nothing else about it matters
 *   2. it is a draft — nobody is waiting on you and nothing is waiting on it
 *   3. a check failed — the only state that names the check, because "1 check
 *      failed" sends you to the PR to find out which
 *   4. changes were requested — a person is waiting
 *   5. checks are still running
 *   6. it is approved
 *   7. none of the above: it is open and nobody has looked
 *
 * 3 above 4 is deliberate and is the one worth arguing about. A reviewer's
 * comment is the more human signal, but a red check is the one that blocks the
 * merge and the one you can act on without anybody else — and when both are
 * true, the review cannot be addressed without a green build anyway.
 */
export function stateWord(pr: PullRequest): Said {
  if (pr.state === 'merged') return { text: 'merged', tone: 'quiet' };
  if (pr.state === 'closed') return { text: 'closed', tone: 'quiet' };
  if (pr.state === 'draft') return { text: 'draft', tone: 'quiet' };

  const failed = firstFailure(pr);
  if (failed !== undefined) return { text: `${failed.name} failed`, tone: 'negative' };
  if (pr.changesRequested.length > 0) return { text: 'changes requested', tone: 'negative' };

  const counts = countChecks(pr.checks);
  if (counts.running > 0) return { text: 'checks running', tone: 'neutral' };
  if (pr.approvals.length > 0) return { text: 'approved', tone: 'positive' };
  return { text: 'open', tone: 'neutral' };
}

/** `1 of 3 checks` / `12 of 12 checks` / `checks not run`. */
export function checksSaid(pr: PullRequest): Said {
  const { total, passed, failed } = countChecks(pr.checks);
  if (total === 0) return { text: 'checks not run', tone: 'quiet' };
  const text = `${passed} of ${total} checks`;
  if (failed > 0) return { text, tone: 'negative' };
  return { text, tone: passed === total ? 'positive' : 'neutral' };
}

/**
 * `@jane` / `@sam ×` / `no review yet`, and nothing at all for a draft.
 *
 * A draft says nothing rather than `no review yet`, because on a draft that is
 * not a gap — it is the expected state, and a row that reports it is a row
 * telling you about something nobody was going to do.
 */
export function reviewSaid(pr: PullRequest): Said | null {
  if (pr.state === 'draft') return null;
  if (pr.changesRequested.length > 0) {
    return { text: pr.changesRequested.map(at).join(' '), tone: 'negative' };
  }
  if (pr.approvals.length > 0) return { text: pr.approvals.map(at).join(' '), tone: 'positive' };
  if (pr.state === 'merged' || pr.state === 'closed') return null;
  return { text: 'no review yet', tone: 'quiet' };
}

const at = (login: string): string => (login.startsWith('@') ? login : `@${login}`);

// --------------------------------------------------------------- the stack

/**
 * Where this PR sits in its repo's stack — `1 of 2`, `2 of 2 · on #301`.
 *
 * `null` for a repo with one PR, which is the common case and must cost nothing
 * to read: `1 of 1` is a fact about a set of one, and drawing it on every row of
 * an ordinary task is exactly the noise 7c refuses at the tab level.
 *
 * A stack is defined by base refs and nothing else — a PR whose base is another
 * open PR's head is on top of it. Order within the stack is therefore derived,
 * not stored, so a rebase that re-points a base is reflected the next sync
 * rather than needing anything to be updated.
 */
export function stackLabel(pr: PullRequest, all: readonly PullRequest[]): string | null {
  const chain = stackOf(pr, all);
  if (chain.length < 2) return null;
  const index = chain.findIndex((entry) => entry.number === pr.number);
  const position = `${index + 1} of ${chain.length}`;
  const under = chain[index - 1];
  return under === undefined ? position : `${position} · on #${under.number}`;
}

/**
 * Every PR of this PR's repo that is linked to it by base refs, bottom first.
 *
 * Walks down to the root and then up, so any member of a stack yields the same
 * chain — which is what makes `n of m` agree between rows. A cycle (two PRs
 * based on each other, which git permits and a person can create) terminates on
 * the seen-set rather than hanging.
 */
export function stackOf(pr: PullRequest, all: readonly PullRequest[]): readonly PullRequest[] {
  const live = all.filter((entry) => entry.repo === pr.repo && isLive(entry));
  if (!isLive(pr)) return [];
  const byHead = new Map(live.map((entry) => [entry.headRef, entry]));

  const seen = new Set<number>([pr.number]);
  const below: PullRequest[] = [];
  for (let at = byHead.get(pr.baseRef); at !== undefined && !seen.has(at.number); at = byHead.get(at.baseRef)) {
    seen.add(at.number);
    below.unshift(at);
  }

  const above: PullRequest[] = [];
  for (
    let at = live.find((entry) => entry.baseRef === pr.headRef);
    at !== undefined && !seen.has(at.number);
    at = live.find((entry) => entry.baseRef === at?.headRef)
  ) {
    seen.add(at.number);
    above.push(at);
  }

  return [...below, pr, ...above];
}

/** Open or draft — something that still has a future. */
export const isLive = (pr: PullRequest): boolean => pr.state === 'open' || pr.state === 'draft';

// ---------------------------------------------------------------- the order

/**
 * The order these have to land in, which is also the order the list is drawn in.
 *
 * Two sources, and they are different KINDS of fact. Within a repo, a base ref
 * is git's own record of what sits on what, and it cannot be wrong. Across
 * repos, git knows nothing, so the only source is a `Depends-on:` trailer
 * somebody wrote — a convention. So this **orders** by dependencies and never
 * refuses on them: an unsatisfiable or circular set falls back to a stable
 * order rather than reporting a cycle the user did not know they had made.
 *
 * The stable fallback is `(repo, number)`. Not `updatedAt`: a list that reorders
 * itself when CI touches a PR is a list whose rows move under the cursor, which
 * §5 refuses outright.
 */
export function landOrder(prs: readonly PullRequest[]): readonly PullRequest[] {
  const live = [...prs].filter(isLive).sort(byRepoThenNumber);
  const byKey = new Map(live.map((pr) => [prKey(pr), pr]));

  /** Everything `pr` must land after, as far as this set knows. */
  const after = (pr: PullRequest): readonly PullRequest[] => {
    const inRepo = live.filter((other) => other.repo === pr.repo && other.headRef === pr.baseRef);
    const across = pr.dependsOn.flatMap((key) => {
      const found = byKey.get(key);
      return found === undefined || found.repo === pr.repo ? [] : [found];
    });
    return [...inRepo, ...across];
  };

  const ordered: PullRequest[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const place = (pr: PullRequest): void => {
    const key = prKey(pr);
    if (placed.has(key)) return;
    // A cycle stops here and the PR is placed where the walk reached it. The
    // alternative is reporting one, and a person who accidentally based two PRs
    // on each other is not helped by a list that refuses to draw.
    if (visiting.has(key)) return;
    visiting.add(key);
    for (const dependency of after(pr)) place(dependency);
    visiting.delete(key);
    placed.add(key);
    ordered.push(pr);
  };

  for (const pr of live) place(pr);
  return ordered;
}

const byRepoThenNumber = (a: PullRequest, b: PullRequest): number =>
  a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo);

/**
 * Can this land, on its own terms?
 *
 * Deliberately narrower than GitHub's `mergeable`, and it takes the pessimistic
 * reading of `unknown`: that value means GitHub has not finished computing the
 * merge and is what you get for the first seconds of every PR's life, so
 * offering Merge on it would be offering a button that fails.
 */
export const canMerge = (pr: PullRequest): boolean =>
  pr.state === 'open' && pr.mergeState === 'clean' && countChecks(pr.checks).failed === 0;

/**
 * The first thing stopping the whole task from landing — `sdk #44` — or `null`
 * when nothing is.
 *
 * In land order, so it names the EARLIEST blocker rather than any blocker: the
 * ones after it may only be blocked because this one is.
 */
export function blockedBy(prs: readonly PullRequest[]): PullRequest | null {
  return landOrder(prs).find((pr) => !canMerge(pr)) ?? null;
}

// ----------------------------------------------------------------- the rollup

/**
 * One state for the whole task — what the rail's glyph is tinted by.
 *
 * The worst thing true of any of its PRs, in the order you would want to be told
 * about them. Finished work is the floor rather than the ceiling: a task whose
 * PRs are all merged is `merged`, and one merged PR among four open ones says
 * nothing about the task.
 */
export type TaskPrState = 'failed' | 'waiting' | 'running' | 'approved' | 'open' | 'merged' | 'none';

export function rollUp(prs: readonly PullRequest[]): TaskPrState {
  if (prs.length === 0) return 'none';
  const live = prs.filter(isLive);
  if (live.length === 0) return prs.some((pr) => pr.state === 'merged') ? 'merged' : 'none';

  if (live.some((pr) => firstFailure(pr) !== undefined)) return 'failed';
  if (live.some((pr) => pr.changesRequested.length > 0)) return 'waiting';
  if (live.some((pr) => countChecks(pr.checks).running > 0)) return 'running';
  // Approved only when EVERY live one is: "this task is approved" is a claim
  // about the task, and one approved PR beside two unreviewed ones is not it.
  if (live.every((pr) => pr.state === 'open' && pr.approvals.length > 0)) return 'approved';
  return 'open';
}

/** What the glyph's tooltip says — the count, then why it is that colour. */
export function rollUpSaid(prs: readonly PullRequest[]): string | null {
  const state = rollUp(prs);
  if (state === 'none') return null;
  const live = prs.filter(isLive);
  if (live.length === 0) {
    const merged = prs.filter((pr) => pr.state === 'merged');
    return merged.length === 1 && merged[0] !== undefined
      ? `#${merged[0].number} merged`
      : `${merged.length} PRs merged`;
  }
  const count = live.length === 1 && live[0] !== undefined ? `#${live[0].number}` : `${live.length} PRs`;
  return `${count} · ${REASONS[state]}`;
}

const REASONS: Readonly<Record<Exclude<TaskPrState, 'none'>, string>> = {
  failed: 'a check failed',
  waiting: 'changes requested',
  running: 'checks running',
  approved: 'approved',
  open: 'no review yet',
  merged: 'merged',
};
