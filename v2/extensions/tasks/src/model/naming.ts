/**
 * Naming a task — the three pure decisions, kept away from anything that spawns.
 *
 * A task's name becomes a directory, a branch and a sidebar row, and until now it
 * was the brief's first line capped at 72 characters. That is how a branch came to
 * be called `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`: the
 * composer is deliberately ONE field, so the title IS the brief.
 *
 * The model returns a short **title** rather than a slug (D18). `slugify` already
 * makes traversal unrepresentable and `uniqueSlug` already resolves collisions
 * once, so handing that pipeline a good six-word title gets a good branch for
 * free — and fixes the row label, which is the same string.
 */

/** More than this and the model is reading a paragraph rather than a task. */
const MAX_BRIEF_CHARS = 2_000;

/** A name becomes a directory. Eight words is already generous. */
const MAX_WORDS = 8;

/** Past this the answer is prose, not a title. */
const MAX_NAME_CHARS = 80;

/** What the heuristic keeps, which is tighter than what a model is allowed. */
const MAX_HEURISTIC_WORDS = 6;

/**
 * Openings that carry no information about the work.
 *
 * Anchored and repeatable, because they stack in real briefs ("please can you…",
 * "#shepherd I wanna…"). Each alternative ends at a word boundary followed by
 * whitespace *or the end of the string*, so a brief that is nothing but filler
 * strips to nothing rather than keeping its last word.
 *
 * `in <repo>` is the newest of them and the narrowest on purpose. It matches only
 * the two shapes that are unmistakably a repo — one with a comma after it
 * (`in shepherd , check…`) or a hyphenated name (`in ai-harness-pulse check…`) —
 * because the greedy version eats the subject of any brief that opens on a place
 * (`in production the retry loop hangs`). Naming the repo in the name is
 * redundant either way: the card already carries it as a chip.
 */
const FILLER =
  /^(?:#\w+(?:\s+|$)|in\s+(?:[\w.]+-[\w.-]+|[\w.-]+\s*,)(?:\s+|$)|(?:hey|hi|ok|okay|so|please|lets|let's)(?:\s+|$)|(?:can|could|would)\s+you(?:\s+|$)|i\s+(?:wanna|want\s+to|need\s+to)(?:\s+|$)|i'?d\s+like\s+to(?:\s+|$)|we\s+(?:should|need\s+to)(?:\s+|$)|help\s+me(?:\s+|$))+/i;

/**
 * A URL is not a word.
 *
 * `can you handle this please: https://browserstack…` spends the whole word
 * budget on a link and then truncates it mid-host, which is how two unrelated
 * tasks ended up with byte-identical rows. The repo is already a chip on the
 * card and the link is in the brief; neither belongs in a name a person scans.
 */
const URL_WORD = /\bhttps?:\/\/\S+/gi;

/**
 * Words a name must not END on.
 *
 * Cutting at a fixed word count lands mid-phrase surprisingly often, and the
 * result reads like a bug rather than an abbreviation:
 * `fix-the-login-redirect-loop-on`, `make-the-composer-show-what-the`,
 * `the-browserstack-session-terminates-early-when`. Trimming these back is the
 * difference between a short name and a truncated one.
 */
const DANGLING =
  /^(?:a|an|the|and|or|but|so|to|of|in|on|at|by|for|from|with|into|onto|when|while|what|which|who|whom|whose|how|where|why|that|this|its|it's|is|are|was|were|be|been|as|if|than|then|too|also|about|over|under|via|per)$/i;

/** What joins two changes, and so what a name must not end on. */
const JOIN = /^(?:&|and|\+|,)$/i;

/**
 * How a model declines.
 *
 * Worth catching precisely because a refusal slugifies into something plausible —
 * `i-m-sorry-i-can-t-help-with-that` is a valid directory name and a terrible one.
 */
const REFUSAL = /^(?:i'?m\s+sorry|sorry|i\s+can(?:'?t|not)|i\s+am\s+unable|as\s+an\s+ai)/i;

/**
 * How much a brief must have moved before the same question is worth re-asking.
 *
 * On CONTENT rather than on a timer alone: a pause after twenty more characters
 * is a different brief, a pause after two is the same one. §7c named budget as
 * the reason `agents` is its own permission, and a per-keystroke ask would spend
 * it several times per task.
 */
const BRIEF_DRIFT_CHARS = 20;

/**
 * Is `next` the brief `asked` was about, a little further along?
 *
 * The prefix half is what makes this a question about a brief rather than about a
 * number. Length alone answered "the git icon does not show up in the sidebar
 * rows" with the name of a task about a pty, because the two are five characters
 * apart — and since the answer came from the cache there was no model call to
 * disagree with it. Every reuse this exists for is the SAME brief still being
 * typed, so a brief that is not an extension of the one asked about is a
 * different brief however closely its length matches.
 */
export function stillTheSameBrief(asked: string, next: string): boolean {
  const grown = next.startsWith(asked) || asked.startsWith(next);
  return grown && Math.abs(asked.length - next.length) < BRIEF_DRIFT_CHARS;
}

/**
 * The prompt never mentions a branch, and the omission is the load-bearing part.
 *
 * `slugify` owns the branch: it lowercases, collapses everything outside
 * `[a-z0-9]` and caps the result. A model told it is naming a branch spends its
 * six words writing that same string by hand — punctuation-free, lowercase,
 * keyword soup — and the sidebar row, which is the same string before slugging,
 * is what pays for it. Asked for a name a person reads, the row reads and the
 * branch is derived from it for free.
 *
 * The `&` rule carries an example because the rule alone does not land: a brief
 * covering two changes is otherwise answered by concatenating them, and
 * `remove live preview fix repo hash` is two tasks in a trench coat.
 */
export function namingPrompt(brief: string): string {
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  return [
    'Name this development task, for a list of tasks a person scans.',
    '',
    'Rules:',
    '- 3 to 6 words. Shorter is better.',
    '- Sentence case: capitalize the first word and the names of things in the',
    '  product ("Live Name preview", "Repo hash"). Nothing else.',
    '- Two separate changes join with "&": "Remove Live Name preview & Repo hash".',
    '- Name what changes. Drop detail that does not tell this task apart from another.',
    '- No quotes, no backticks, no trailing period.',
    '',
    'Reply with the name alone.',
    '',
    'Task:',
    trimmed,
  ].join('\n');
}

/**
 * The model's answer, or nothing.
 *
 * `undefined` means "use the fallback" and is a completely ordinary outcome: a
 * cheap model asked for six words will sometimes decline, sometimes explain
 * itself, and often wrap the answer in decoration.
 */
export function readName(answer: string): string | undefined {
  const first = answer
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first === undefined) return undefined;

  const bare = first
    .replace(/^[`"'*\s]+/, '')
    .replace(/[`"'*\s]+$/, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (bare === '' || bare.length > MAX_NAME_CHARS) return undefined;
  if (REFUSAL.test(bare)) return undefined;

  const words = bare.split(' ').slice(0, MAX_WORDS);
  // The word cap counts the join, so a cut can land on it. One word shorter beats
  // a name that ends mid-conjunction.
  while (words.length > 1 && JOIN.test(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

/**
 * The name you get when the model is slow, off, or unauthenticated.
 *
 * `undefined` means "I have nothing better than what you already have", and the
 * caller then keeps its own title — which is at least what the user typed.
 */
export function heuristicName(brief: string): string | undefined {
  const firstLine = brief
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return undefined;

  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const words = sentence
    // Links go before the filler strip, so a brief that is only a link and an
    // opening (`can you handle this: https://…`) strips to nothing and the
    // caller keeps what the user typed rather than getting half a hostname.
    .replace(URL_WORD, '')
    .replace(FILLER, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
  if (words.length === 0) return undefined;

  const kept = words.slice(0, MAX_HEURISTIC_WORDS);
  // Trimmed only because of the cut: a name that was ALREADY short keeps its
  // shape, so a one-word brief is not deleted for being an article.
  while (kept.length > 1 && words.length > MAX_HEURISTIC_WORDS && DANGLING.test(kept.at(-1) ?? '')) {
    kept.pop();
  }
  // A name is not a sentence fragment. Stripping the filler off `can you handle
  // this please: …` leaves the colon that was pointing at the rest of the brief,
  // and a cut at six words lands on a comma often enough to be worth one line.
  // `…` is in the class because the composer's own `titleOf` appends one when it
  // caps the brief's first line, and that title is an input here.
  const name = kept.join(' ').replace(/[\s.,:;!?…-]+$/, '');
  return name === '' ? undefined : name;
}
