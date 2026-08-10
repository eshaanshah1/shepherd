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
 */
const FILLER =
  /^(?:#\w+(?:\s+|$)|(?:hey|hi|ok|okay|so|please|lets|let's)(?:\s+|$)|(?:can|could|would)\s+you(?:\s+|$)|i\s+(?:wanna|want\s+to|need\s+to)(?:\s+|$)|i'?d\s+like\s+to(?:\s+|$)|we\s+(?:should|need\s+to)(?:\s+|$)|help\s+me(?:\s+|$))+/i;

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

/**
 * How a model declines.
 *
 * Worth catching precisely because a refusal slugifies into something plausible —
 * `i-m-sorry-i-can-t-help-with-that` is a valid directory name and a terrible one.
 */
const REFUSAL = /^(?:i'?m\s+sorry|sorry|i\s+can(?:'?t|not)|i\s+am\s+unable|as\s+an\s+ai)/i;

export function namingPrompt(brief: string): string {
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  return [
    'Write a short title for this development task, for use as a git branch name.',
    'Rules: at most 6 words, imperative mood, no quotes, no backticks, no trailing period.',
    'Reply with the title alone and nothing else.',
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
  return bare.split(' ').slice(0, MAX_WORDS).join(' ');
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
  return kept.join(' ');
}
