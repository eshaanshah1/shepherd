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

  /**
   * The two shapes that were on screen in the rail, both taken verbatim.
   *
   * Neither is hypothetical: they are the labels a screenshot of the Shipped
   * drawer showed, and the second appeared TWICE and was byte-identical both
   * times — a link eats the whole word budget and truncates mid-host, so two
   * unrelated tasks became one unreadable row repeated.
   */
  it('drops the repo the brief opens on — the card already carries it as a chip', () => {
    expect(heuristicName('in shepherd , I just created a new task and it looks wrong')).toBe(
      'I just created a new task',
    );
    expect(heuristicName('in ai-harness-pulse check the stack:desktop dimension')).toBe(
      'check the stack:desktop dimension',
    );
  });

  it('leaves a brief that merely opens on a place alone', () => {
    // The greedy version of the rule above ate the subject of this one, and the
    // subject is the whole name: `in the` and `in production` are not repo
    // names. A comma after it or a hyphen inside it is the tell.
    expect(heuristicName('in production the retry loop hangs')).toBe(
      'in production the retry loop hangs',
    );
  });

  it('drops a URL rather than spending the name on half a hostname', () => {
    // The link was the whole budget: this brief truncated to
    // `can you handle this please: https://brow…` in the rail, and the SECOND
    // task written the same way was byte-identical to it. What is left says
    // little, because the brief said little — but it says it in three words and
    // it is no longer indistinguishable from its neighbour.
    expect(
      heuristicName('can you handle this please: https://browserstack.atlassian.net/browse/ABC-1'),
    ).toBe('handle this please');
    expect(heuristicName('fix the retry loop https://example.com/a/b/c please')).toBe(
      'fix the retry loop please',
    );
  });

  it('has no answer for a brief that is nothing but filler', () => {
    // Stripping everything must not leave an empty name for `slugify` to turn
    // into the literal fallback `task`; `undefined` sends the caller back to its
    // own title, which is at least what the user typed.
    expect(heuristicName('I wanna')).toBeUndefined();
    expect(heuristicName('please')).toBeUndefined();
  });
});
