import { describe, expect, it } from 'vitest';
import { heuristicName, namingPrompt, readName } from './naming.ts';
import { slugify } from './slug.ts';

/**
 * The three pure decisions in naming a task, and the most defect-prone code in
 * the feature: a model asked for six words returns junk often enough that this is
 * the cheapest place to catch it. Measured — three of seven answers came back
 * wrapped in backticks, and one arrived under a preamble.
 */

/** The brief that produced this branch's own name. The fallback is held to it. */
const REAL_BRIEF =
  "#shepherd I wanna add a new feature / extension. It's something like a \"dumb\" model, that I can use for simple tasks, like commit messages, titling threads, etc, etc.";

describe('namingPrompt', () => {
  it('carries the brief and asks for one short line', () => {
    const prompt = namingPrompt('fix the login redirect loop');
    expect(prompt).toContain('fix the login redirect loop');
    expect(prompt.toLowerCase()).toContain('title');
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

describe('heuristicName', () => {
  it('strips the filler a real brief starts with', () => {
    // This is what you SEE whenever the model is slow, off or unauthenticated, so
    // it is held to the real input rather than to a tidy one. Before this, the
    // brief above produced `shepherd-i-wanna-add-a-new-feature-extension-it-s-something`.
    const name = heuristicName(REAL_BRIEF);
    expect(name).toBeDefined();
    const slug = slugify(name ?? '');
    expect(slug).not.toContain('i-wanna');
    expect(slug).not.toContain('shepherd');
    expect(slug.split('-').length).toBeLessThanOrEqual(6);
  });

  it('takes the first sentence, not the first 72 characters', () => {
    expect(heuristicName('Fix the login loop. Then also rewrite the router.')).toBe('Fix the login loop');
  });

  it('drops a leading please and a question form', () => {
    expect(heuristicName('Please can you fix the login loop')).toBe('fix the login loop');
  });

  it('does not end on a dangling function word when it had to cut', () => {
    // Found by looking at real output rather than at assertions: cutting at a
    // fixed word count lands mid-phrase often, and `fix-the-login-redirect-loop-on`
    // reads like a truncation bug rather than a short name.
    expect(heuristicName('Please can you fix the login redirect loop on Safari')).toBe('fix the login redirect loop');
    expect(heuristicName('i want to make the composer show what the task will be called')).toBe(
      'make the composer show',
    );
    expect(heuristicName('The BrowserStack session terminates early when the device is real')).toBe(
      'The BrowserStack session terminates early',
    );
  });

  it('keeps a name that was already short, even if it ends on such a word', () => {
    // The trim is a consequence of cutting. A brief that never needed cutting is
    // the user's own phrasing, and shortening it further would be editing them.
    expect(heuristicName('Ship it')).toBe('Ship it');
  });

  it('has no answer for an empty brief, so the caller keeps its own title', () => {
    expect(heuristicName('')).toBeUndefined();
    expect(heuristicName('   \n  ')).toBeUndefined();
  });

  it('has no answer for a brief that is nothing but filler', () => {
    // Stripping everything must not leave an empty name for `slugify` to turn
    // into the literal fallback `task`; `undefined` sends the caller back to its
    // own title, which is at least what the user typed.
    expect(heuristicName('I wanna')).toBeUndefined();
    expect(heuristicName('please')).toBeUndefined();
  });
});
