/**
 * A task's first name — minted rather than derived.
 *
 * It becomes the folder and the branch the moment a task is created, before
 * anything knows what the task is about, so it cannot come from the brief and it
 * must not wait for a model. What it has to be is short, unambiguous when spoken
 * ("the merino one"), and already legal as both a directory and a git ref —
 * which is why both lists are lowercase ASCII with no separators of their own.
 *
 * `random` is a parameter for the reason `ctx.clock` is: a name nobody can
 * predict is a name no test can assert on.
 */

import type { RepoRefs } from './branch.ts';

/** Non-empty tuples, so an index-zero fallback is a `string` and not a maybe. */
const COLOURS: readonly [string, ...string[]] = [
  'amber', 'ash', 'auburn', 'azure', 'bramble', 'brass', 'bronze', 'chalk',
  'cinder', 'clay', 'cobalt', 'copper', 'coral', 'cream', 'dusk', 'ember',
  'fawn', 'flint', 'frost', 'garnet', 'hazel', 'indigo', 'ivory', 'jade',
  'lilac', 'linen', 'mauve', 'moss', 'ochre', 'olive', 'onyx', 'pearl',
  'rowan', 'russet', 'saffron', 'sable', 'sage', 'sandy', 'slate', 'sorrel',
  'teal', 'umber', 'verdant', 'wheat',
];

const BREEDS: readonly [string, ...string[]] = [
  'awassi', 'balwen', 'beulah', 'bluefaced', 'boreray', 'cheviot', 'clun',
  'colbred', 'columbia', 'coopworth', 'corriedale', 'cotswold', 'debouillet',
  'dorper', 'dorset', 'exmoor', 'gotland', 'gulf', 'hampshire', 'herdwick',
  'icelandic', 'jacob', 'karakul', 'katahdin', 'lacaune', 'leicester',
  'lincoln', 'lonk', 'manx', 'merino', 'navajo', 'norfolk', 'oxford',
  'perendale', 'polwarth', 'portland', 'rambouillet', 'romney', 'romanov',
  'ryeland', 'shetland', 'shropshire', 'soay', 'southdown', 'suffolk',
  'targhee', 'teeswater', 'texel', 'tunis', 'wensleydale',
];

/**
 * The fallback is not defensive noise: a `random` that answers exactly 1 — or a
 * caller's sequence that runs past its own end — indexes one past the list.
 */
function pick(list: readonly [string, ...string[]], random: () => number): string {
  return list[Math.floor(random() * list.length)] ?? list[0];
}

export function mintName(random: () => number): string {
  return `${pick(COLOURS, random)}-${pick(BREEDS, random)}`;
}

/**
 * Would `resolveBranch` find this name already there?
 *
 * The three questions it asks, in its own order and with its own suffix match,
 * so a name this says is free is one `resolveBranch` will CREATE rather than
 * check out. A minted name has no relationship to the work, so a collision here
 * is somebody else's branch and adopting it would be silent.
 */
export function branchTaken(name: string, refs: readonly RepoRefs[]): boolean {
  return refs.some(
    (repo) =>
      repo.localBranches.includes(name) ||
      repo.checkedOutBranches.includes(name) ||
      repo.remoteBranches.some((ref) => ref.endsWith(`/${name}`)),
  );
}

/** How many fresh names to try before giving up on randomness. */
const MINT_ATTEMPTS = 5;

/**
 * A branch name free in EVERY repo of the task.
 *
 * Across all of them together rather than per repo, because one task keeps one
 * branch name: `taskProvisioned` publishes a single `branch` for the whole task,
 * and a per-repo answer would make that fact a lie.
 *
 * Bounded rather than looping on the mint: the case this guards is not "unlucky"
 * but "this repo has more branches than there are names", where a loop does not
 * terminate. Past the bound it falls back to the rule `uniqueSlug` uses on a
 * folder, which does terminate — a repo holds finitely many refs.
 */
export function pickBranch(
  first: string,
  refs: readonly RepoRefs[],
  mint: () => string,
  attempts = MINT_ATTEMPTS,
): string {
  let candidate = first;
  for (let n = 0; n <= attempts; n += 1) {
    if (!branchTaken(candidate, refs)) return candidate;
    candidate = mint();
  }
  for (let n = 2; ; n += 1) {
    const suffixed = `${candidate}-${n}`;
    if (!branchTaken(suffixed, refs)) return suffixed;
  }
}
