import {
  IconArchive,
  IconChevronDown,
  IconDots,
  IconEye,
  IconFolder,
  IconFolderFilled,
  IconLayoutColumns,
  IconLayoutRows,
  IconMaximize,
  IconPlus,
  IconSearch,
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
  chevron: IconChevronDown,
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
  plus: IconPlus,
  trash: IconTrash,
  search: IconSearch,
  'split-right': IconLayoutColumns,
  'split-down': IconLayoutRows,
  zoom: IconMaximize,
};

export function namedGlyph(name: string | undefined): ComponentType<TablerIconProps> {
  return (name === undefined ? undefined : NAMED_GLYPHS[name]) ?? IconDots;
}
