import {
  IconArchive,
  IconArrowBackUp,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconEye,
  IconFolder,
  IconFolderFilled,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestDraft,
  IconLayoutColumns,
  IconLayoutRows,
  IconMaximize,
  IconPlus,
  IconSearch,
  IconShip,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';
import type { IconProps as TablerIconProps } from '@tabler/icons-react';

/**
 * The named-glyph allow-list — §7: "a contributed view picks from a small
 * allow-list that grows one line at a time."
 *
 * `Icon`'s rule is take a COMPONENT, never a name, because a name means bundling
 * 5,700 glyphs. That rule is for call sites inside this repo, which can import
 * the one they want. A CONTRIBUTED row cannot: its service half runs in a
 * utility process with no DOM and sends a string over a port, so something has
 * to turn that string into a component — and the choice is whether that
 * something is an allow-list or the whole icon package.
 *
 * This is the allow-list. It lives in `@shepherd/ui` rather than in the shell so
 * a contributed UI can resolve a name without importing Tabler itself, which the
 * import boundaries forbid and should: an extension reaching the icon package
 * directly could ship a glyph at a fourth size and a second stroke weight.
 *
 * Growing it is one line, and that is the point — a name that is not here draws
 * the fallback rather than nothing, because a hover action with no glyph is an
 * invisible button.
 */
export const NAMED_GLYPHS: Readonly<Record<string, ComponentType<TablerIconProps>>> = {
  archive: IconArchive,
  check: IconCheck,
  chevron: IconChevronDown,
  /*
   * The two horizontal ones, and they are a PAIR: `chevron-right` means "there
   * is more this way" on a row you can open, and `chevron-left` is the way back
   * from what it opened. Adding one without the other is how a surface grows a
   * door with no handle on the inside.
   */
  'chevron-right': IconChevronRight,
  'chevron-left': IconChevronLeft,
  close: IconX,
  dots: IconDots,
  eye: IconEye,
  /*
   * Two folders, and the pair IS the fact a repo picker has to state: filled =
   * this directory is a repo you can pick, outline = a directory on the way to
   * one. Tabler ships both, so the distinction costs no hand-rolled path and
   * keeps one stroke weight.
   */
  folder: IconFolder,
  'folder-filled': IconFolderFilled,
  /*
   * A pull request, which is the only git noun in here and is deliberately the
   * only one: it is a thing that exists on a server and has a state, where a
   * branch or a commit is a thing in a directory and has none. The rail draws it
   * for a task with PRs open, tinted by the worst of them.
   *
   * FOUR of them, because a pull request's state is a thing the glyph itself
   * says everywhere else this noun is drawn — every forge in the world uses
   * this family and a reader already knows it on sight. Drawing one shape and
   * leaving the state to a coloured dot beside it throws that away and asks the
   * reader to learn our dot instead. `merged` is the merge glyph rather than a
   * fifth pull-request variant, because that is the shape the arrow actually
   * makes when it lands.
   */
  'pull-request': IconGitPullRequest,
  'pull-request-closed': IconGitPullRequestClosed,
  'pull-request-draft': IconGitPullRequestDraft,
  'pull-request-merged': IconGitMerge,
  plus: IconPlus,
  /*
   * Finishing with a task, and taking it back — the rail's two most-made
   * gestures, and the pair has to read as one axis. An undo arrow rather than a
   * second ship glyph for the reverse: un-shipping is not a kind of shipping,
   * it is the withdrawal of a decision.
   */
  ship: IconShip,
  unship: IconArrowBackUp,
  trash: IconTrash,
  search: IconSearch,
  'split-right': IconLayoutColumns,
  'split-down': IconLayoutRows,
  zoom: IconMaximize,
};

export function namedGlyph(name: string | undefined): ComponentType<TablerIconProps> {
  return (name === undefined ? undefined : NAMED_GLYPHS[name]) ?? IconDots;
}
