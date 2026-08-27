import { describe, expect, it } from 'vitest';
import { Bases } from './bases.ts';

const SHEPHERD = { owner: 'eshaanshah1', repo: 'shepherd' };
const OTHER = { owner: 'eshaanshah1', repo: 'searcher' };

/** Counts what it was asked, so a cache miss is visible rather than inferred. */
function asker(answers: readonly (string | null | undefined)[]) {
  const asked: string[] = [];
  let at = 0;
  return {
    asked,
    ask: (slug: { owner: string; repo: string }): Promise<string | null | undefined> => {
      asked.push(`${slug.owner}/${slug.repo}`);
      const answer = answers[Math.min(at, answers.length - 1)];
      at += 1;
      return Promise.resolve(answer);
    },
  };
}

describe('Bases', () => {
  it('asks once per repo, however many times it is read', async () => {
    // The whole point: `prReadiness` runs on every draw of the changes pane, and
    // that pane redrew 90 times a minute against a 5000/hour REST limit.
    const { asked, ask } = asker(['master']);
    const bases = new Bases(ask);
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(asked).toEqual(['eshaanshah1/shepherd']);
  });

  it('keys by owner/repo, so two slug objects for one repo are one question', async () => {
    const { asked, ask } = asker(['master']);
    const bases = new Bases(ask);
    await bases.of({ ...SHEPHERD });
    await bases.of({ ...SHEPHERD });
    expect(asked).toHaveLength(1);
  });

  it('tells two repos apart', async () => {
    const { asked, ask } = asker(['master', 'main']);
    const bases = new Bases(ask);
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(await bases.of(OTHER)).toBe('main');
    expect(asked).toEqual(['eshaanshah1/shepherd', 'eshaanshah1/searcher']);
  });

  it('makes one request when several readers arrive at once', async () => {
    // Every pane on a task asks at the same moment, which is the case the
    // in-flight map exists for.
    const { asked, ask } = asker(['master']);
    const bases = new Bases(ask);
    const all = await Promise.all([bases.of(SHEPHERD), bases.of(SHEPHERD), bases.of(SHEPHERD)]);
    expect(all).toEqual(['master', 'master', 'master']);
    expect(asked).toHaveLength(1);
  });

  it('remembers a null — a repo the token cannot see is a fact about the repo', async () => {
    const { asked, ask } = asker([null]);
    const bases = new Bases(ask);
    expect(await bases.of(SHEPHERD)).toBeNull();
    expect(await bases.of(SHEPHERD)).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('does NOT remember an undefined — nobody was signed in, so nothing was asked', async () => {
    /*
     * The regression this cache would otherwise have shipped: signed out, the
     * pane caches "cannot tell which branch to open against", and a `gh auth
     * login` does not clear it. It would have read as the sign-in not working.
     */
    const { asked, ask } = asker([undefined, undefined, 'master']);
    const bases = new Bases(ask);
    expect(await bases.of(SHEPHERD)).toBeNull();
    expect(await bases.of(SHEPHERD)).toBeNull();
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(asked).toHaveLength(3);
    // And once it IS an answer, it is kept.
    expect(await bases.of(SHEPHERD)).toBe('master');
    expect(asked).toHaveLength(3);
  });

  it('asks again after forget — the verb somebody runs after renaming a trunk', async () => {
    const { asked, ask } = asker(['master', 'main']);
    const bases = new Bases(ask);
    expect(await bases.of(SHEPHERD)).toBe('master');
    bases.forget();
    expect(await bases.of(SHEPHERD)).toBe('main');
    expect(asked).toHaveLength(2);
  });
});
