import { describe, expect, it } from 'vitest';
import { firstLine, namingPrompt, readName, stillTheSameBrief } from './naming.ts';
import { slugify } from './slug.ts';

/**
 * The pure decisions in naming a task, and the most defect-prone code in
 * the feature: a model asked for six words returns junk often enough that this is
 * the cheapest place to catch it. Measured — three of seven answers came back
 * wrapped in backticks, and one arrived under a preamble.
 */

/** The brief that produced this branch's own name. The fallback is held to it. */
const REAL_BRIEF =
  "#shepherd I wanna add a new feature / extension. It's something like a \"dumb\" model, that I can use for simple tasks, like commit messages, titling threads, etc, etc.";

describe('namingPrompt', () => {
  it('carries the brief and asks for a few words', () => {
    const prompt = namingPrompt('fix the login redirect loop');
    expect(prompt).toContain('fix the login redirect loop');
    expect(prompt).toContain('3 to 6 words');
  });

  it('never mentions a branch, so the answer is a name and not a slug', () => {
    // `slugify` owns the branch. Told it is naming one, the model writes that
    // string by hand — lowercase, punctuation-free — and the sidebar row is the
    // same string before slugging.
    expect(namingPrompt('fix the login redirect loop').toLowerCase()).not.toContain('branch');
  });

  it('shows the two-change join rather than only describing it', () => {
    // The rule alone does not land: a brief covering two changes comes back
    // concatenated (`remove live preview fix repo hash`).
    expect(namingPrompt('remove the preview and fix the hash')).toContain(
      '"Remove Live Name preview & Repo hash"',
    );
  });

  it('caps a very long brief, because a paragraph is not a better question', () => {
    expect(namingPrompt('x'.repeat(10_000)).length).toBeLessThan(3_000);
  });
});

describe('readName', () => {
  it('takes a plain short title', () => {
    expect(readName('Add a cheap model seam')).toBe('Add a cheap model seam');
  });

  it('unwraps quotes, backticks and a trailing stop', () => {
    expect(readName('"Add a cheap model seam."')).toBe('Add a cheap model seam');
    expect(readName('`add-cheap-model-seam`')).toBe('add-cheap-model-seam');
  });

  it('collapses whitespace', () => {
    expect(readName('Add   a  cheap\tmodel seam')).toBe('Add a cheap model seam');
  });

  it('caps at eight words, because the answer becomes a directory name', () => {
    expect(readName('one two three four five six seven eight nine ten')).toBe(
      'one two three four five six seven eight',
    );
  });

  it('keeps a two-change name whole, join and all', () => {
    expect(readName('Remove Live Name preview & Repo hash')).toBe('Remove Live Name preview & Repo hash');
  });

  it('does not end on the join the word cap cut it at', () => {
    // The cap counts `&`, so a nine-token answer can be cut onto it. A name
    // ending mid-conjunction reads as a truncation bug.
    expect(readName('one two three four five six seven &  nine')).toBe('one two three four five six seven');
    expect(readName('remove the preview and fix the hash and also the thing')).toBe(
      'remove the preview and fix the hash',
    );
  });

  it('refuses a paragraph', () => {
    expect(readName('x'.repeat(200))).toBeUndefined();
  });

  it('refuses a refusal', () => {
    // These slugify into something perfectly plausible, which is what makes them
    // worth catching here rather than downstream.
    expect(readName("I'm sorry, I can't help with that")).toBeUndefined();
    expect(readName('I cannot name this task')).toBeUndefined();
    expect(readName('As an AI, I do not name things')).toBeUndefined();
  });

  it('refuses nothing at all', () => {
    expect(readName('')).toBeUndefined();
    expect(readName('   ')).toBeUndefined();
    expect(readName('`` ')).toBeUndefined();
  });

  it('cannot produce a name that escapes its directory', () => {
    // Belt and braces: `slugify` already makes traversal unrepresentable, and this
    // asserts the two COMPOSE rather than trusting either alone.
    const slug = slugify(readName('../../etc/passwd') ?? '');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
  });
});

describe('stillTheSameBrief', () => {
  it('holds while the brief the model was asked about is still being typed', () => {
    expect(stillTheSameBrief('fix the retry loop', 'fix the retry loop in the daemon')).toBe(true);
    expect(stillTheSameBrief('fix the retry loop', 'fix the retry loop')).toBe(true);
    // Backwards too: the composer asks at an idle pause, and a backspace before
    // Create must not pay for the model a second time.
    expect(stillTheSameBrief('fix the retry loop now', 'fix the retry loop')).toBe(true);
  });

  it('does not hold for a different brief that happens to be a similar length', () => {
    // The whole defect: two unrelated tasks five characters apart shared a name,
    // and the cache answered the second without a model call to disagree.
    expect(
      stillTheSameBrief(
        'the git icon does not show up in the sidebar rows',
        'the daemon drops a pty when the app restarts',
      ),
    ).toBe(false);
  });

  it('does not hold once the same brief has really moved on', () => {
    expect(
      stillTheSameBrief('fix the retry loop', 'fix the retry loop and also rewrite the whole daemon'),
    ).toBe(false);
  });
});

describe('firstLine', () => {
  it('is the first line, trimmed', () => {
    expect(firstLine('  fix the login redirect  \nand then some more')).toBe('fix the login redirect');
  });

  it('is empty for an empty brief', () => {
    expect(firstLine('   ')).toBe('');
  });

  // It becomes a tab title. Somebody's first line is occasionally a paragraph.
  it('caps a long line and marks the cut', () => {
    const capped = firstLine('a'.repeat(200));
    expect(capped).toHaveLength(72);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('leaves a line of exactly the cap alone', () => {
    const exact = 'b'.repeat(72);
    expect(firstLine(exact)).toBe(exact);
  });
});
