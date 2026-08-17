/**
 * What a task row hands its own component — and the reader that refuses to trust
 * it.
 *
 * This shape is written by the service half, crosses an IPC port as `unknown`,
 * and is read here. `ok` says a call succeeded, never that a value has a shape,
 * so every field below is checked rather than cast. A component that cast this
 * would be one malformed contribution away from throwing inside React's render
 * — and this renders in the rail, so the throw takes the whole window.
 *
 * The defaults are all "say less", never "make something up": an unreadable diff
 * draws no diff line, an unreadable count draws no badge. A card that omits a
 * fact is honest; one that invents a zero is not.
 */

export type CardMark = 'working' | 'waiting' | 'ready' | 'resting' | 'failed' | 'shipped';

export interface CardDiff {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

export interface CardRepo {
  readonly name: string;
  /** `repo1`…`repo4` — a ROLE name, resolved by the renderer. Never a colour. */
  readonly mark: string;
}

/**
 * What the agent is waiting for.
 *
 * `answers` is the *inline* pair — `Allow` / `Deny`, or whatever two words the
 * agent used. Absent means the question does not fit a card (an
 * `AskUserQuestion` with five options, a header, multi-select, or options that
 * are sentences), and the card then draws a single `check →` bar that does what
 * clicking the card does. One inline shape, and everything else is a door.
 */
export interface CardQuestion {
  readonly text: string;
  /** The identifier inside the question — the one word you must actually read. */
  readonly subject?: string;
  readonly answers?: readonly [CardAnswer, CardAnswer];
}

export interface CardAnswer {
  readonly label: string;
  /** The command that answers it, invoked through the row's own `invoke`. */
  readonly command: string;
  readonly args?: unknown;
  /** The key bound while this card is the top of the rail. */
  readonly key?: string;
}

/**
 * One thing another extension says about this task — `tasks.cardFacts`.
 *
 * Re-declared here rather than imported from `src/manifest.ts` because this is
 * the READER's copy: everything in this file crosses an IPC port as `unknown`
 * and is checked rather than cast, and a type imported from the writer would
 * describe what was sent instead of what arrived.
 */
export interface CardFact {
  /** A glyph name, resolved by the renderer against its own set. Never an SVG. */
  readonly icon?: string;
  /** A few characters of mono text. Never a colour, never a length. */
  readonly label?: string;
  readonly tone: 'positive' | 'negative' | 'neutral' | 'quiet';
  /** What it means, in words — the tooltip and the accessible name. */
  readonly title: string;
  readonly command?: { readonly id: string; readonly args?: unknown };
}

export interface CardData {
  readonly mark: CardMark;
  /*
   * There is deliberately no `elapsed` field.
   *
   * A task row carried one — `4m` / `2h` / `3d` — and it was removed from both
   * regions rather than reformatted. On finished work it reported the wrong
   * subject (task age, not ship time); corrected to a ship clock it was true and
   * still not worth a column, because the Shipped region already answers "when"
   * once per DAY in its headers. The trailing cell holds the row's one verb.
   */
  /**
   * How many tasks this ONE row stands for, when it is more than one.
   *
   * Only ever set on a shipped row, and only for tasks that shipped the same day
   * under the same title — two identical lines in a record are worth stating as a
   * fact rather than drawing as what looks like a rendering bug.
   *
   * Absent at one, so the card's test is presence. The row still opens exactly one
   * task (the most recent of them), which is why the count is drawn: it is the
   * disclosure that the line is standing in for more than it opens.
   */
  readonly dupe?: number;
  /**
   * The step this task is on, while it is being built.
   *
   * It used to reach the rail as the row's own LABEL, because until the model
   * answered there was no name for the label to hold. There is one from birth
   * now — the brief — so the step sits BESIDE the name instead of replacing it,
   * and beside rather than under, because §10 refuses a row that grows to say
   * something. Absent the moment the work ends, which is what makes it
   * disappearing the "ready" signal.
   */
  readonly stage?: string;
  /** One sentence of what is happening. */
  readonly summary?: string;
  readonly diff?: CardDiff;
  readonly suite?: { readonly total: number; readonly passed: number };
  readonly repos?: readonly CardRepo[];
  /**
   * The task's TABS, as marks and nothing else.
   *
   * The rail used to nest up to three labelled tab rows under a task. §5 puts
   * tabs in the stage — "the rail names the task, a tab is named for what you
   * opened it for" — and a two-level rail also repeats a name down the
   * hierarchy, which §6 refuses outright.
   *
   * What the nested rows genuinely bought was seeing WITHIN a task that
   * something wants you, without navigating to find out. A strip of bare marks
   * keeps exactly that and drops the part that was duplication: you can see
   * three tabs with one waiting, and the labelled list is one click away in the
   * tab strip where it belongs.
   */
  readonly tabs?: readonly CardMark[];
  readonly question?: CardQuestion;
  /** A failed run's exit code, drawn in mono. */
  readonly exitCode?: number;
  /**
   * This task is finished — draw it as one dimmed line.
   *
   * One flag rather than each field going quietly absent, because the fields
   * BELOW are suppressed for a shared reason: they describe live work. A diff is
   * what a worktree currently holds, a repo chip is somewhere you can go, a suite
   * result is a run that just happened, and a shipped task's checkouts are a
   * snapshot in `refs/shepherd/*`. Leaving each one to be undefined on its own
   * would make "did the service half forget, or is there nothing to say" an
   * unanswerable question.
   *
   * The MARK is not suppressed. "I shipped this while it was red" is exactly what
   * a permanently-visible region of finished work should be able to tell you.
   */
  readonly shipped?: boolean;
  /**
   * What OTHER extensions say about this task — a PR's state, a deploy, a
   * check.
   *
   * Not suppressed by `shipped`, unlike everything above it. The fields that go
   * quiet on a finished row describe live work; a fact does not — the motivating
   * one is a merged PR number, which is the most durable thing a finished row
   * can carry. A provider that has nothing to say about finished work is told so
   * and says nothing.
   */
  readonly facts?: readonly CardFact[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

const MARKS: readonly CardMark[] = ['working', 'waiting', 'ready', 'resting', 'failed', 'shipped'];

const mark = (value: unknown): CardMark | undefined =>
  MARKS.find((candidate) => candidate === value);

function readAnswer(value: unknown): CardAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const label = str(value['label']);
  const command = str(value['command']);
  // Both or nothing: a button with no verb is a button that does nothing when
  // pressed, which is worse than an absent button.
  if (label === undefined || command === undefined) return undefined;
  return { label, command, args: value['args'], key: str(value['key']) };
}

function readQuestion(value: unknown): CardQuestion | undefined {
  if (!isRecord(value)) return undefined;
  const text = str(value['text']);
  if (text === undefined) return undefined;

  const raw = value['answers'];
  let answers: readonly [CardAnswer, CardAnswer] | undefined;
  if (Array.isArray(raw) && raw.length === 2) {
    const first = readAnswer(raw[0]);
    const second = readAnswer(raw[1]);
    // Exactly two usable answers, or none — a card with ONE button is a card
    // whose other option is invisible, and the `check →` door is the honest
    // shape for anything that is not a clean pair.
    if (first !== undefined && second !== undefined) answers = [first, second];
  }
  return { text, subject: str(value['subject']), answers };
}

function readDiff(value: unknown): CardDiff | undefined {
  if (!isRecord(value)) return undefined;
  const added = int(value['added']);
  const removed = int(value['removed']);
  const files = int(value['files']);
  if (added === undefined || removed === undefined || files === undefined) return undefined;
  // Nothing changed draws no line at all, rather than `+0 −0 · 0 files`.
  if (added === 0 && removed === 0 && files === 0) return undefined;
  return { added, removed, files };
}

export function readCardData(value: unknown): CardData | null {
  if (!isRecord(value)) return null;
  const state = mark(value['mark']);
  // The mark is the one field with no honest default: it is the whole point of
  // the row, and a card that guessed `resting` would say "nothing is happening"
  // about a task that might be waiting on you.
  if (state === undefined) return null;

  const repos = Array.isArray(value['repos'])
    ? value['repos'].flatMap((entry): CardRepo[] => {
        if (!isRecord(entry)) return [];
        const name = str(entry['name']);
        const identity = str(entry['mark']);
        return name === undefined || identity === undefined ? [] : [{ name, mark: identity }];
      })
    : undefined;

  const tabs = Array.isArray(value['tabs'])
    ? value['tabs'].flatMap((entry): CardMark[] => {
        const state = mark(entry);
        return state === undefined ? [] : [state];
      })
    : undefined;

  const suiteRaw = value['suite'];
  let suite: { readonly total: number; readonly passed: number } | undefined;
  if (isRecord(suiteRaw)) {
    const total = int(suiteRaw['total']);
    const passed = int(suiteRaw['passed']);
    if (total !== undefined && passed !== undefined && total > 0) suite = { total, passed };
  }

  /*
   * A count of one is not a duplicate and a count below one is not a count — both
   * reach the card as absent, so it never has to ask twice.
   *
   * **And only on shipped work**, which is a refusal rather than a tidy-up. Two LIVE
   * tasks of the same name are two things you are separately doing, and one row
   * standing for both would hide one that might be waiting on you. The service half
   * does not send it for live work; enforcing that here is what makes the field's
   * docstring true for every consumer rather than for the current caller.
   */
  const shipped = value['shipped'] === true;
  const dupe = int(value['dupe']);
  const facts = readFacts(value['facts']);

  return {
    mark: state,
    ...(shipped && dupe !== undefined && dupe > 1 ? { dupe } : {}),
    stage: str(value['stage']),
    summary: str(value['summary']),
    diff: readDiff(value['diff']),
    suite,
    repos: repos !== undefined && repos.length > 0 ? repos : undefined,
    tabs: tabs !== undefined && tabs.length > 0 ? tabs : undefined,
    question: readQuestion(value['question']),
    exitCode: int(value['exitCode']),
    ...(shipped ? { shipped: true as const } : {}),
    ...(facts.length === 0 ? {} : { facts }),
  };
}

/**
 * The facts, checked one at a time — a malformed one is dropped and its
 * neighbours are kept.
 *
 * These come from an extension this code has never seen, through a point any
 * extension may register with, so "one bad contribution takes the whole cell"
 * would be a defect a third party could ship into the rail.
 *
 * `title` is required for the reason the SDK says it is: a mark whose only
 * content is a colour cannot be read out or asserted on. `tone` defaults to
 * `quiet` rather than being refused — an unrecognised tone is a spelling
 * mistake, and the quiet reading is the one that claims nothing.
 */
const TONES = ['positive', 'negative', 'neutral', 'quiet'] as const;

function readFacts(value: unknown): readonly CardFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CardFact[] => {
    if (!isRecord(entry)) return [];
    const title = str(entry['title']);
    if (title === undefined) return [];
    const icon = str(entry['icon']);
    const label = str(entry['label']);
    // Neither a glyph nor a word is a cell with nothing in it, which still takes
    // the space of one.
    if (icon === undefined && label === undefined) return [];
    const rawTone = entry['tone'];
    const tone = TONES.find((candidate) => candidate === rawTone) ?? 'quiet';

    const rawCommand = entry['command'];
    let command: CardFact['command'];
    if (isRecord(rawCommand)) {
      const id = str(rawCommand['id']);
      // Both or nothing: a cell that looks clickable and runs nothing is the
      // affordance lie the rest of this file already refuses.
      if (id !== undefined) command = { id, args: rawCommand['args'] };
    }

    return [{ ...(icon === undefined ? {} : { icon }), ...(label === undefined ? {} : { label }), tone, title, ...(command === undefined ? {} : { command }) }];
  });
}
