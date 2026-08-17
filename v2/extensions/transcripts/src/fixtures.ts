import { readFileSync } from 'node:fs';

/**
 * The fixture corpus, as data.
 *
 * Hand-written rather than scrubbed from a real session, deliberately: the
 * golden test in `parse/golden.test.ts` compares whole digests, so a fixture has
 * to be reproducible on any machine and readable in a diff. Each one carries
 * exactly one shape the parser has to get right — see the design doc, §6.
 *
 * A new fixture joins the golden run by being added here and nowhere else.
 */
export const FIXTURES = [
  'tool-loop',
  'interrupt',
  'compaction',
  'duplicate-usage',
  'markup-prompt',
  'titles-and-recap',
] as const;

export type FixtureName = (typeof FIXTURES)[number];

export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}.jsonl`, import.meta.url), 'utf8');
}
