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

/**
 * How a check ended, reduced from the several vocabularies GitHub uses.
 *
 * **`queued` and `running` are two states because a manual check makes them
 * two.** This was one — anything not `COMPLETED` was `running` — and a repo
 * whose required checks are triggered by hand therefore said `checks running`
 * for as long as the PR was open, with nothing running. `IN_PROGRESS` is a
 * runner executing; `QUEUED`/`WAITING`/`REQUESTED` is a job that may never
 * start, and a state nothing will clear must not drive a colour.
 *
 * **`blocked` is `ACTION_REQUIRED`**, which used to sit in `skipped`. It is a
 * COMPLETED conclusion — GitHub finished and reported that a human must act —
 * so unlike a queued job it is an affirmative signal with a subject, and it does
 * clear once you clear it.
 */
export const CHECK_STATES = ['passed', 'failed', 'running', 'queued', 'blocked', 'skipped'] as const;

/**
 * The list is the type, rather than the type being a union a list is kept in
 * step with by hand. `ui/review-data.ts` had that second arrangement and its
 * list was three names short, so a check in either state added since it was
 * written was dropped at the port and drawn nowhere.
 */
export type CheckState = (typeof CHECK_STATES)[number];

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
  /** Epoch ms of its first comment — where it sits in the conversation. */
  readonly at: number;
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
   * What GitHub says happened to it, carried rather than inferred.
   *
   * It is the difference between the two reasons a file arrives with no patch,
   * which the pane used to report as one: a rename with no edits has NOTHING to
   * diff, and a file whose patch was never asked for has one nobody fetched.
   * Both drew "the diff for this file has not been fetched", which is a lie in
   * the first case and unactionable in the second.
   */
  readonly status?: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  /** Where a renamed file came from — the only interesting thing about it. */
  readonly previousPath?: string;
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

/**
 * One comment on the pull request ITSELF, which is not a review thread.
 *
 * The distinction GitHub draws and this model did not: a `ReviewThread` is
 * anchored to a line of the diff, and a `Comment` is written on the PR. The
 * things that arrive as the second are a bot reporting why a required check has
 * not run, a reviewer's reply, the sentence saying what to do next — and with
 * only threads read, the Conversation tab said `0` on a PR with a conversation.
 */
export interface Comment {
  readonly id: string;
  /** `someone` when GitHub has no account to name — a deleted user. */
  readonly author: string;
  /** Markdown SOURCE, for the same reason `body` is — the pane renders it. */
  readonly body: string;
  /** Epoch ms. */
  readonly at: number;
}

/** One commit of a PR — what the Commits tab lists. */
export interface Commit {
  readonly sha: string;
  /** The first line. A list is a list; the body is on GitHub. */
  readonly subject: string;
  readonly author: string;
  readonly at: number;
  /** What this ONE commit changed. From GraphQL, so it costs no extra call. */
  readonly added: number;
  readonly removed: number;
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
   * The description, as markdown SOURCE.
   *
   * The source rather than GitHub's markup-stripped rendering of it, because
   * this field is drawn by a renderer (`ui/markdown.tsx`) and a body arriving
   * pre-flattened has nothing left to render.
   */
  readonly body: string;
  /**
   * Who OPENED the pull request, which is not who wrote its commits.
   *
   * The header used to say `commits[0].author` and call it the author. Those are
   * two different people the moment somebody pushes from one git identity and
   * opens the PR from another — which is ordinary for anyone with a work
   * account and a personal one, and made this pane disagree with GitHub's own
   * line about the same PR. Empty when GitHub has no account to name, which is
   * what a deleted user looks like.
   */
  readonly author: string;
  readonly state: PrState;
  readonly baseRef: string;
  readonly headRef: string;
  /**
   * The commit at the head of it — what `ownership.ts` judges a finished PR by.
   *
   * Carried rather than taken from `commits[0]`, which is only the tip for a PR
   * of fifty commits or fewer: the query asks for the FIRST fifty, so a longer
   * one yields the oldest of them and the real head appears nowhere in the list.
   *
   * Empty when GitHub sent nothing, which every reader must treat as "unknown"
   * rather than "none".
   */
  readonly headOid: string;
  readonly url: string;
  readonly added: number;
  readonly removed: number;
  readonly changedFiles: number;
  readonly checks: readonly CheckRun[];
  /** Logins that approved. */
  readonly approvals: readonly string[];
  /** Logins that asked for changes. */
  readonly changesRequested: readonly string[];
  /**
   * GitHub's own verdict on the REVIEW requirement, which no count of approvals
   * can be derived into.
   *
   * `approvals.length === 0` says nobody has approved; it does not say whether
   * anybody has to. That is branch protection, and only the server knows it —
   * so a PR waiting on its first review was indistinguishable here from one
   * nobody needed to look at, and the pane said "GitHub has not said why" about
   * the single commonest reason a PR cannot merge.
   *
   * `none` is both "no rule" and "a server that did not answer", because
   * nothing downstream should treat a missing field as a demand for a review
   * that may not be required.
   */
  readonly reviewDecision: 'approved' | 'changes' | 'required' | 'none';
  readonly threads: readonly ReviewThread[];
  /** What was said on the PR rather than on a line of it, oldest first. */
  readonly comments: readonly Comment[];
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

/**
 * An author's colour, derived from their login.
 *
 * The comment marks were one flat grey square, so three people saying three
 * things looked like one person saying them three times. A byline you have to
 * READ to tell apart is a byline doing no work in a scan.
 *
 * DERIVED, not random. A random hue would be a different person on every render
 * and a different person in two panes showing the same thread — the whole value
 * of an identity mark is that it is the same mark next time. This is a hash, so
 * `coderabbitai` is the same colour in every PR, in every task, forever.
 *
 * Hue only. Saturation and lightness are fixed at values that sit in this
 * palette rather than on top of it — §2's rule that a saturated value needs a
 * job, honoured by giving all of them the same weight and letting only the angle
 * carry the identity. The five hues that MEAN something are unaffected: this is
 * a sixth axis, the same exemption the repo marks take.
 */
export function authorHue(login: string): number {
  // FNV-1a, because it is four lines and has no collisions worth caring about
  // over a handful of logins on one screen.
  let hash = 0x811c9dc5;
  for (let at = 0; at < login.length; at += 1) {
    hash ^= login.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** The mark's fill, as a CSS colour a stylesheet can use directly. */
export const authorTint = (login: string): string => `oklch(0.62 0.11 ${authorHue(login)})`;

/** `owner/repo#123` — the identity every cross-reference uses. */
export const prKey = (pr: Pick<PullRequest, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`;

// ------------------------------------------------------------------- checks

export interface CheckCount {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** A runner is executing. NOT a job sitting in the queue — see `queued`. */
  readonly running: number;
  /** Accepted but not started. May never start; nothing here clears itself. */
  readonly queued: number;
  /** `ACTION_REQUIRED` — finished, and waiting on a human at GitHub. */
  readonly blocked: number;
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
    queued: counted.filter((check) => check.state === 'queued').length,
    blocked: counted.filter((check) => check.state === 'blocked').length,
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
 * token NAME (§7). The failure, the good outcome, the ordinary fact, the thing
 * that is not asking for anything — and two the always-drawn PR glyph added:
 * `pending` (in flight; it will clear itself) and `done` (merged, the one
 * terminal state). They are named for the JOB, not the hue, which is what keeps
 * an extension from reaching for a colour by the back door.
 */
export type Tone = 'negative' | 'positive' | 'neutral' | 'pending' | 'done' | 'quiet';

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
 *   5. a check finished asking for a human — the gate, and it names itself
 *   6. checks are still running
 *   7. it is approved
 *   8. none of the above: it is open and nobody has looked
 *
 * **Queued checks appear nowhere in that order**, deliberately. A job that has
 * not started has reported nothing, and on a repo whose checks are triggered by
 * hand it never will — so it is drawn as the difference between `passed` and
 * `total` (`1 of 3 checks`) and given no phrase of its own. A phrase that never
 * changes is one you stop reading, and this one used to say `checks running`.
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
  if (counts.blocked > 0) {
    const gate = pr.checks.find((check) => check.state === 'blocked');
    // Named, for `firstFailure`'s reason: "a check needs you" sends you to the
    // PR to find out which one, and the name is the whole answer.
    return { text: `${gate?.name ?? 'a check'} needs you`, tone: 'pending' };
  }
  if (counts.running > 0) return { text: 'checks running', tone: 'pending' };
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
 * Whether this can merge, and — in one sentence — why not.
 *
 * The footer used to be the whole of this: a Merge button that vanished when it
 * could not be pressed, and a phrase beside it saying which "not yet". That put
 * the one fact you open this pane for at the bottom of a surface you had to
 * scroll, and split it across two elements that had to be read together.
 *
 * So it is one value, and the pane draws it as a SENTENCE at the top rather than
 * as a bar: a mark, a verdict, and the reason in prose. `because` is written to
 * follow an em dash, which is why it opens lowercase and ends in a full stop.
 *
 * Every reason names something you can act on. `unknown` is the one that cannot
 * — GitHub has not finished working it out — and it says so rather than
 * inventing a blocker.
 */
export interface Gate {
  readonly ok: boolean;
  readonly verdict: string;
  /** The clause after the dash, or `''` when the verdict says it all. */
  readonly because: string;
}

export function mergeGate(pr: PullRequest): Gate {
  if (pr.state === 'merged') return { ok: false, verdict: 'Merged', because: '' };
  if (pr.state === 'closed') return { ok: false, verdict: 'Closed', because: 'without merging.' };
  if (pr.state === 'draft') return { ok: false, verdict: 'Draft', because: 'mark it ready on GitHub before it can merge.' };

  if (canMerge(pr)) {
    const counts = countChecks(pr.checks);
    const approvals = pr.approvals.length;
    const said = [
      approvals === 0 ? '' : `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`,
      counts.total === 0 ? '' : `${counts.passed} of ${counts.total} checks passed`,
    ].filter((part) => part !== '');
    return { ok: true, verdict: 'Ready to merge', because: said.length === 0 ? '' : `${said.join(', ')}.` };
  }

  return { ok: false, verdict: 'Merge blocked', because: whyBlocked(pr) };
}

/**
 * The reasons, joined — ALL of them, not the first.
 *
 * The old sentence named one, which is the wrong number for the case it exists
 * to explain: a PR held up by a missing review AND a check that never ran told
 * you about the check, you cleared it, and the pane then told you about the
 * review. Two round trips to learn two facts it had both of.
 */
function whyBlocked(pr: PullRequest): string {
  const reasons: string[] = [];

  if (pr.mergeState === 'dirty') reasons.push('it conflicts with the base branch');
  if (pr.mergeState === 'behind') reasons.push('it is behind the base branch');

  const failed = pr.checks.filter((check) => check.state === 'failed');
  if (failed.length === 1) reasons.push(`${failed[0]?.name ?? 'a check'} failed`);
  else if (failed.length > 1) reasons.push(`${failed.length} checks failed`);

  const counts = countChecks(pr.checks);
  if (counts.queued > 0) reasons.push(`${counts.queued === 1 ? 'a required check has' : `${counts.queued} checks have`} not reported`);
  if (counts.blocked > 0) reasons.push(`${counts.blocked === 1 ? 'a check is' : `${counts.blocked} checks are`} waiting on a person`);
  /*
   * The review, LAST, and from GitHub's decision rather than from the approval
   * count. It comes last because it is the reason that clears by somebody else
   * acting: everything above it is yours to go and fix.
   */
  if (pr.reviewDecision === 'changes') reasons.push('a reviewer asked for changes');
  else if (pr.reviewDecision === 'required') reasons.push('it needs an approving review');
  else if (pr.changesRequested.length > 0) reasons.push('a reviewer asked for changes');

  if (reasons.length === 0) {
    // `unknown` is GitHub still deciding; anything else here is a mergeState we
    // read pessimistically and cannot name.
    return pr.mergeState === 'unknown'
      ? 'GitHub is still working out whether it can.'
      : 'GitHub has not said why.';
  }
  return `${joinWords(reasons)}.`;
}

const joinWords = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;

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
export type TaskPrState =
  | 'failed'
  | 'waiting'
  | 'blocked'
  | 'running'
  | 'approved'
  | 'open'
  | 'merged'
  | 'closed'
  | 'none';

export function rollUp(prs: readonly PullRequest[]): TaskPrState {
  if (prs.length === 0) return 'none';
  const live = prs.filter(isLive);
  if (live.length === 0) {
    if (prs.some((pr) => pr.state === 'merged')) return 'merged';
    // Every PR closed and none merged. It used to answer `none`, which drew no
    // glyph at all and made "this task's work was abandoned" look identical to
    // "this task has no PRs" — the one distinction a record is for.
    return prs.some((pr) => pr.state === 'closed') ? 'closed' : 'none';
  }

  if (live.some((pr) => firstFailure(pr) !== undefined)) return 'failed';
  if (live.some((pr) => pr.changesRequested.length > 0)) return 'waiting';
  /*
   * A gate above a running check, for `stateWord`'s reason one level up: both
   * are pending, and the one you can DO something about wins the slot.
   */
  if (live.some((pr) => countChecks(pr.checks).blocked > 0)) return 'blocked';
  /*
   * `running`, never `queued`. A job that has not started may never start, and
   * this used to be `status !== 'COMPLETED'` — so a repo with hand-triggered
   * required checks sat at "checks running" for the life of every PR. See
   * `CheckState`; the fix is in `query.ts` and this line is the reason it
   * matters.
   */
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
    // `0 PRs merged` was reachable the moment `closed` became a state of its
    // own: nothing live and nothing merged is a task whose PRs were all closed,
    // and the merged branch below would have counted zero of them.
    if (merged.length === 0) {
      const closed = prs.filter((pr) => pr.state === 'closed');
      return closed.length === 1 && closed[0] !== undefined
        ? `#${closed[0].number} closed unmerged`
        : `${closed.length} PRs closed unmerged`;
    }
    return merged.length === 1 && merged[0] !== undefined
      ? `#${merged[0].number} merged`
      : `${merged.length} PRs merged`;
  }
  const count = live.length === 1 && live[0] !== undefined ? `#${live[0].number}` : `${live.length} PRs`;
  return `${count} · ${REASONS[state]}`;
}

/**
 * Why the glyph is the colour it is, in words — the tail of its tooltip and of
 * its accessible name.
 *
 * Exported because it is the half of §5 that carries the two states the glyph
 * cannot separate on its own: `failed`/`waiting` share a shape and a tone, as do
 * `blocked`/`running`, and these sentences are what tell them apart. A test
 * asserts they are all distinct for exactly that reason.
 */
export const REASONS: Readonly<Record<Exclude<TaskPrState, 'none'>, string>> = {
  failed: 'a check failed',
  waiting: 'changes requested',
  blocked: 'a check needs you',
  running: 'checks running',
  approved: 'approved',
  open: 'no review yet',
  merged: 'merged',
  closed: 'closed unmerged',
};
