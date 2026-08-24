/**
 * Is this document a skill, and what is wrong with it?
 *
 * Two specs disagree about `SKILL.md` and only one of them consumes the file.
 * skillsdirectory.com documents `version`, `author`, `tags` and `requires`;
 * Claude Code reads `name` and `description` and ignores the rest. So the two
 * questions are answered separately here:
 *
 *   - **is it a skill** is Claude Code's answer, and it is the two keys. A pane
 *     that refused to install a file Claude Code reads happily would be wrong
 *     about the only thing it is for.
 *   - **is it a GOOD skill** is the directory's answer, and every part of it is a
 *     warning. Nothing here can stop an install.
 *
 * Pure, so the whole file is testable with strings and no host.
 */

/** Where the directory's advice sits. Not a limit — see `warnings`. */
export const DESCRIPTION_MAX = 200;

/** What Claude Code accepts as a skill directory name. */
const SLUG = /^[a-z0-9-]+$/;

/**
 * How far down the document the closing fence is looked for.
 *
 * Frontmatter is a HEADER, so a block longer than this is not one — and without a
 * bound the pathological case is real: a document that opens with `---` and never
 * closes it (somebody mid-type) would scan every line of a long scratch pad, and
 * `frontmatter.ts` does the same scan on every keystroke. Bounding it makes both
 * O(header) rather than O(document).
 */
export const FENCE_SEARCH_LIMIT = 200;

export interface SkillWarning {
  /** The frontmatter key the warning is about, so it can be drawn beside it. */
  readonly field: string;
  readonly message: string;
}

/**
 * Everything about a skill except its body.
 *
 * Split from `Skill` for COST, not tidiness. The pane re-derives the tab's name
 * and glyph on every save, and `body` is a copy of the whole document — so a
 * detection that returned it would allocate the document again every time typing
 * paused. Nothing on the presentation path needs it; the install does, once.
 */
export interface SkillHead {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly requires?: readonly string[];
  readonly version?: string;
  readonly author?: string;
  /** The frontmatter as written, fences excluded. What gets written back out. */
  readonly frontmatter: string;
  readonly warnings: readonly SkillWarning[];
}

export interface Skill extends SkillHead {
  /** Everything after the closing fence, trimmed of its leading blank lines. */
  readonly body: string;
}

/**
 * The name as a directory, which is where Claude Code actually reads it from.
 *
 * Empty when nothing survives, and the caller refuses rather than inventing a
 * name: a directory called `skill-1` is a skill nobody can find again.
 */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A scalar's quotes are syntax, not part of the value. */
function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted === null ? value : (quoted[2] ?? '');
}

/**
 * A flow sequence — `[a, b]`. Nested flow is not supported and does not need to
 * be: a tag list is strings.
 */
function readFlowSequence(value: string): readonly string[] | undefined {
  const flow = /^\[(.*)\]$/.exec(value);
  if (flow === null) return undefined;
  const inner = (flow[1] ?? '').trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => unquote(item.trim()));
}

/**
 * The frontmatter block, as a map of raw values, plus the keys whose SHAPE was a
 * list. A scalar and a one-item list are different answers and `tags: ops` has to
 * be reportable as the mistake it is, so the shape travels rather than being
 * guessed at from the string.
 */
interface Parsed {
  readonly scalars: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
}

/**
 * The YAML subset frontmatter actually uses: `key: value`, folded (`>`) and
 * literal (`|`) blocks, flow and block sequences.
 *
 * Hand-rolled rather than vendored, and not because a parser would be hard to
 * add: `extensions/*​/src` imports the SDK and stdlib only (`boundaries.js`), and
 * a six-line frontmatter block is not a reason to argue with that. A key this
 * cannot read is SKIPPED rather than fatal — the two keys that decide anything
 * are scalars, and somebody's nested `metadata:` must not stop the install.
 */
function parseFrontmatter(text: string): Parsed {
  const scalars = new Map<string, string>();
  const lists = new Map<string, readonly string[]>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Comments and blank lines. A top-level key has no leading space; an indented
    // line here belongs to a block we have already consumed, or to a nested map
    // this parser is declining to read.
    if (line.trim() === '' || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const key = pair[1] ?? '';
    const rest = (pair[2] ?? '').trim();

    // A block scalar: `>` folds its lines into one, `|` keeps the newlines.
    const block = /^([>|])[-+]?$/.exec(rest);
    if (block !== null) {
      const held: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] ?? '') || (lines[i + 1] ?? '').trim() === '')) {
        i += 1;
        held.push((lines[i] ?? '').trim());
      }
      while (held.length > 0 && held[held.length - 1] === '') held.pop();
      scalars.set(key, block[1] === '|' ? held.join('\n') : held.join(' ').trim());
      continue;
    }

    if (rest === '') {
      // Either a block sequence under this key, or a nested map we skip.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1] ?? '')) {
        i += 1;
        items.push(unquote((lines[i] ?? '').replace(/^\s+-\s*/, '').trim()));
      }
      if (items.length > 0) lists.set(key, items);
      else scalars.set(key, '');
      continue;
    }

    const flow = readFlowSequence(rest);
    if (flow !== undefined) lists.set(key, flow);
    else scalars.set(key, unquote(rest));
  }

  return { scalars, lists };
}

/** A list-shaped key, and a warning when it was written as a scalar instead. */
function readList(
  key: string,
  parsed: Parsed,
  warnings: SkillWarning[],
): readonly string[] | undefined {
  const list = parsed.lists.get(key);
  if (list !== undefined) return list;
  const scalar = parsed.scalars.get(key);
  if (scalar === undefined || scalar === '') return undefined;
  warnings.push({ field: key, message: `${key} reads as a list: [${scalar}]` });
  return undefined;
}

/**
 * The document as lines, CRLF normalised.
 *
 * Normalised FIRST, everywhere, so a Windows document and a Unix one produce the
 * same offsets — the editor counts `\n`.
 */
const linesOf = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n');

/**
 * The two fence lines, by index, or `undefined` for a document that is not
 * fenced.
 *
 * One function because BOTH readers need it and they must agree: the body is
 * "everything after the closing fence", and a second way of finding that fence is
 * a second answer to where the body starts. The first version of `readSkill` found
 * it with `indexOf('---')`, which misses a fence written `--- ` — a difference
 * `trim()` erases here and an exact match does not.
 */
function fences(lines: readonly string[]): { open: number; close: number } | undefined {
  /*
   * The fence must be the FIRST thing in the document, blank lines aside. A
   * `---` further down is a thematic break, and a note whose second paragraph is
   * a horizontal rule is not a skill.
   */
  let open = 0;
  while (open < lines.length && (lines[open] ?? '').trim() === '') open += 1;
  if ((lines[open] ?? '').trim() !== '---') return undefined;

  // Bounded — see `FENCE_SEARCH_LIMIT`. An unterminated fence is somebody
  // mid-type, not a skill yet, and looking for it forever is what makes a long
  // document expensive to type in.
  const limit = Math.min(lines.length, open + 1 + FENCE_SEARCH_LIMIT);
  let close = open + 1;
  while (close < limit && (lines[close] ?? '').trim() !== '---') close += 1;
  if (close >= limit) return undefined;

  return { open, close };
}

export function readSkillHead(text: string): SkillHead | undefined {
  const lines = linesOf(text);
  const fence = fences(lines);
  if (fence === undefined) return undefined;
  const { open, close } = fence;

  const frontmatter = lines.slice(open + 1, close).join('\n');
  const parsed = parseFrontmatter(frontmatter);

  const name = parsed.scalars.get('name') ?? '';
  const description = parsed.scalars.get('description') ?? '';
  if (name === '' || description === '') return undefined;

  const warnings: SkillWarning[] = [];

  if (!SLUG.test(name)) {
    const slug = skillSlug(name);
    warnings.push({
      field: 'name',
      message:
        slug === ''
          ? 'A name needs at least one letter or digit. Lowercase letters, numbers and hyphens.'
          : `Lowercase letters, numbers and hyphens only. Installs as ${slug}.`,
    });
  }

  if (description.length > DESCRIPTION_MAX) {
    warnings.push({
      field: 'description',
      message: `${String(description.length)} characters. Skills read best under ${String(DESCRIPTION_MAX)}.`,
    });
  }

  const tags = readList('tags', parsed, warnings);
  const requires = readList('requires', parsed, warnings);

  return {
    name,
    description,
    ...(tags === undefined ? {} : { tags }),
    ...(requires === undefined ? {} : { requires }),
    ...(parsed.scalars.has('version') ? { version: parsed.scalars.get('version') ?? '' } : {}),
    ...(parsed.scalars.has('author') ? { author: parsed.scalars.get('author') ?? '' } : {}),
    frontmatter,
    warnings,
  };
}

/**
 * The whole skill, body included. What the INSTALL calls, once.
 *
 * Re-runs the head parse rather than taking one: the two are called from
 * different processes at different moments, and threading a parsed head through a
 * command envelope would put a second copy of this file's output on the wire.
 */
export function readSkill(text: string): Skill | undefined {
  const head = readSkillHead(text);
  if (head === undefined) return undefined;

  const lines = linesOf(text);
  // Non-null by construction: `readSkillHead` answered, so the fences are there.
  const close = fences(lines)?.close ?? 0;
  return {
    ...head,
    body: lines
      .slice(close + 1)
      .join('\n')
      .replace(/^\n+/, '')
      .trimEnd(),
  };
}
