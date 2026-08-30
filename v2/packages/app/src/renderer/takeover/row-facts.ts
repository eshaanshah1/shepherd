/**
 * The optional facts a contributed row may carry in its `data`, read
 * defensively and WITHOUT knowing whose row it is.
 *
 * A tree row already tells the shell three things in typed fields — `tint`,
 * `busy`, `root` — and the shell already maps all three for every extension
 * (`markState` in `view-dock.tsx` says so in as many words). The takeover needs
 * four more to draw a triage screen rather than a list: how long a thing has
 * been going, what it changed, which repos it touches, and the question it is
 * blocked on with the verbs that answer it.
 *
 * Those live in `data`, which is `unknown` by contract — it crossed a port from
 * an extension this code has never seen. So this is a reader and not a cast, in
 * the shape `readCardData` established one layer up: every field optional, a
 * wrong shape dropped rather than thrown on, and a row that carries none of it
 * drawn as a plain row. **It names no extension**, which is the point: any tree
 * may publish these facts and none has to.
 *
 * What it deliberately does NOT read is a group. Which region a row belongs to
 * is the shell's reading of the facts below — see `triage.ts` — because the
 * regions are the takeover's vocabulary and an extension that could name one
 * would be deciding the screen's shape from the outside.
 */

import type { MarkState } from '@shepherd/ui';

export interface RowDiff {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

export interface RowRepo {
  readonly name: string;
  /** A token NAME (`repo1`…`repo4`), resolved by the renderer. Never a colour. */
  readonly mark: string;
}

export interface RowAnswer {
  readonly label: string;
  readonly command: string;
  readonly args?: unknown;
  /** The single character that presses it — `Y` / `N` in the takeover. */
  readonly key?: string;
}

export interface RowQuestion {
  readonly text: string;
  readonly subject?: string;
  /** Exactly two or none: one button is a card whose other option is invisible. */
  readonly answers?: readonly [RowAnswer, RowAnswer];
}

/**
 * Why this row is not asking for attention right now, and when it will again.
 *
 * A row that is snoozed is still in the list — the takeover's promise is that
 * nothing is ever lost — so this is a REASON rather than a filter, and the
 * `label` is the extension's own words ("later today", "when agents finish").
 */
export interface RowSnooze {
  readonly label: string;
  /** Epoch ms, when the reason is a time. Absent for "when agents finish". */
  readonly wakeAt?: number;
}

/**
 * The ways this row can be put off, as the extension declares them.
 *
 * The same shape a question's answers take, and for the same reason: the shell
 * draws a menu and runs a verb it was handed, rather than knowing that
 * `tasks.snooze` exists. A row that publishes none has no `Later` — and the
 * button is then absent rather than present and inert, which is the whole
 * difference between a surface that is honest and one that lies.
 */
export interface RowLater {
  /** What the control says. `Later` for a task; another extension may differ. */
  readonly label: string;
  readonly options: readonly RowAnswer[];
}

export interface RowFacts {
  readonly mark?: MarkState;
  readonly elapsed?: string;
  readonly summary?: string;
  readonly diff?: RowDiff;
  readonly repos?: readonly RowRepo[];
  readonly question?: RowQuestion;
  readonly snooze?: RowSnooze;
  readonly later?: RowLater;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

const MARKS: readonly MarkState[] = ['working', 'waiting', 'ready', 'resting', 'failed', 'shipped'];

const readMark = (value: unknown): MarkState | undefined => MARKS.find((candidate) => candidate === value);

function readDiff(value: unknown): RowDiff | undefined {
  if (!isRecord(value)) return undefined;
  const added = int(value['added']);
  const removed = int(value['removed']);
  const files = int(value['files']);
  if (added === undefined || removed === undefined || files === undefined) return undefined;
  // Nothing changed draws no line at all, rather than `+0 −0 · 0 files`.
  if (added === 0 && removed === 0 && files === 0) return undefined;
  return { added, removed, files };
}

function readRepos(value: unknown): readonly RowRepo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RowRepo[] = [];
  for (const each of value) {
    if (!isRecord(each)) continue;
    const name = str(each['name']);
    const mark = str(each['mark']);
    if (name === undefined || mark === undefined) continue;
    out.push({ name, mark });
  }
  return out.length === 0 ? undefined : out;
}

function readAnswer(value: unknown): RowAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const label = str(value['label']);
  const command = str(value['command']);
  // Both or nothing: a button with no verb does nothing when pressed, which is
  // worse than an absent button.
  if (label === undefined || command === undefined) return undefined;
  return { label, command, args: value['args'], key: str(value['key']) };
}

function readQuestion(value: unknown): RowQuestion | undefined {
  if (!isRecord(value)) return undefined;
  const text = str(value['text']);
  if (text === undefined) return undefined;
  const raw = value['answers'];
  let answers: readonly [RowAnswer, RowAnswer] | undefined;
  if (Array.isArray(raw) && raw.length === 2) {
    const first = readAnswer(raw[0]);
    const second = readAnswer(raw[1]);
    if (first !== undefined && second !== undefined) answers = [first, second];
  }
  return { text, subject: str(value['subject']), ...(answers === undefined ? {} : { answers }) };
}

function readLater(value: unknown): RowLater | undefined {
  if (!isRecord(value)) return undefined;
  const label = str(value['label']);
  const raw = value['options'];
  if (label === undefined || !Array.isArray(raw)) return undefined;
  const options = raw.map(readAnswer).filter((each): each is RowAnswer => each !== undefined);
  // No usable option is no menu. A `Later` that opens on nothing is worse than
  // no `Later`, which is the same call `readQuestion` makes one function up.
  return options.length === 0 ? undefined : { label, options };
}

function readSnooze(value: unknown): RowSnooze | undefined {
  if (!isRecord(value)) return undefined;
  const label = str(value['label']);
  if (label === undefined) return undefined;
  const wakeAt = int(value['wakeAt']);
  return { label, ...(wakeAt === undefined ? {} : { wakeAt }) };
}

/**
 * Read whatever of the above a row's `data` happens to carry.
 *
 * Always answers an object — a row with no data at all is a row with no extra
 * facts, not an error. Every caller therefore reads `facts.diff` rather than
 * branching on whether there were facts.
 */
export function readRowFacts(data: unknown): RowFacts {
  if (!isRecord(data)) return {};
  return {
    ...(readMark(data['mark']) === undefined ? {} : { mark: readMark(data['mark']) as MarkState }),
    ...(str(data['elapsed']) === undefined ? {} : { elapsed: str(data['elapsed']) as string }),
    ...(str(data['summary']) === undefined ? {} : { summary: str(data['summary']) as string }),
    ...(readDiff(data['diff']) === undefined ? {} : { diff: readDiff(data['diff']) as RowDiff }),
    ...(readRepos(data['repos']) === undefined ? {} : { repos: readRepos(data['repos']) as readonly RowRepo[] }),
    ...(readQuestion(data['question']) === undefined
      ? {}
      : { question: readQuestion(data['question']) as RowQuestion }),
    ...(readSnooze(data['snooze']) === undefined ? {} : { snooze: readSnooze(data['snooze']) as RowSnooze }),
    ...(readLater(data['later']) === undefined ? {} : { later: readLater(data['later']) as RowLater }),
  };
}
