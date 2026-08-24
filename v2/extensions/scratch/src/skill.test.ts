import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX, FENCE_SEARCH_LIMIT, readSkill, readSkillHead, skillSlug } from './skill.ts';

/** The shortest document that is a skill. Both required keys, nothing else. */
const minimal = ['---', 'name: deploy-checks', 'description: Runs the pre-deploy suite.', '---', '', '# Deploy checks'].join(
  '\n',
);

describe('readSkill — what qualifies', () => {
  it('reads a document with both required keys', () => {
    const skill = readSkill(minimal);
    expect(skill?.name).toBe('deploy-checks');
    expect(skill?.description).toBe('Runs the pre-deploy suite.');
    expect(skill?.warnings).toEqual([]);
  });

  it('is not a skill without a leading fence', () => {
    expect(readSkill('# Deploy checks\n\nname: deploy-checks\n')).toBeUndefined();
  });

  /*
   * The fence has to be the FIRST thing. A `---` further down a document is a
   * thematic break, and a scratch pad whose second paragraph happens to be a
   * horizontal rule must not become a skill.
   */
  it('is not a skill when the fence is not first', () => {
    const text = ['Some notes.', '', '---', 'name: deploy-checks', 'description: A thing.', '---'].join('\n');
    expect(readSkill(text)).toBeUndefined();
  });

  it('skips leading blank lines, which people leave', () => {
    expect(readSkill(`\n\n${minimal}`)?.name).toBe('deploy-checks');
  });

  it('is not a skill with only a name', () => {
    expect(readSkill('---\nname: deploy-checks\n---\n')).toBeUndefined();
  });

  it('is not a skill with only a description', () => {
    expect(readSkill('---\ndescription: A thing.\n---\n')).toBeUndefined();
  });

  it('is not a skill when the fence never closes', () => {
    expect(readSkill('---\nname: deploy-checks\ndescription: A thing.\n')).toBeUndefined();
  });

  it('is not a skill when a required value is empty', () => {
    expect(readSkill('---\nname:\ndescription: A thing.\n---\n')).toBeUndefined();
  });

  it('reads an empty body — a skill with no instructions yet is still a skill', () => {
    expect(readSkill('---\nname: a\ndescription: B.\n---\n')?.body).toBe('');
  });
});

describe('readSkill — the YAML frontmatter actually uses', () => {
  it('takes a folded block as one line', () => {
    const text = ['---', 'name: deploy-checks', 'description: >', '  Runs the suite', '  and reports.', '---'].join('\n');
    expect(readSkill(text)?.description).toBe('Runs the suite and reports.');
  });

  it('keeps the newlines in a literal block', () => {
    const text = ['---', 'name: a', 'description: |', '  one', '  two', '---'].join('\n');
    expect(readSkill(text)?.description).toBe('one\ntwo');
  });

  it('reads a flow sequence', () => {
    const text = ['---', 'name: a', 'description: B.', 'tags: [ops, ci]', '---'].join('\n');
    expect(readSkill(text)?.tags).toEqual(['ops', 'ci']);
  });

  it('reads a block sequence', () => {
    const text = ['---', 'name: a', 'description: B.', 'requires:', '  - git', '  - eslint', '---'].join('\n');
    expect(readSkill(text)?.requires).toEqual(['git', 'eslint']);
  });

  it('strips quotes from a scalar', () => {
    const text = ['---', 'name: "deploy-checks"', "description: 'A thing.'", '---'].join('\n');
    const skill = readSkill(text);
    expect(skill?.name).toBe('deploy-checks');
    expect(skill?.description).toBe('A thing.');
  });

  it('ignores a comment line', () => {
    const text = ['---', '# what this is', 'name: a', 'description: B.', '---'].join('\n');
    expect(readSkill(text)?.name).toBe('a');
  });

  /*
   * A key this parser cannot read is carried through rather than failing the
   * document: the two keys that decide anything are scalars, and a nested map
   * somebody added is not a reason to stop offering the install.
   */
  it('survives a key it cannot parse', () => {
    const text = ['---', 'name: a', 'description: B.', 'metadata:', '  nested:', '    deep: 1', '---'].join('\n');
    expect(readSkill(text)?.name).toBe('a');
  });

  it('keeps the raw frontmatter and body apart', () => {
    const skill = readSkill(minimal);
    expect(skill?.frontmatter).toBe('name: deploy-checks\ndescription: Runs the pre-deploy suite.');
    expect(skill?.body).toBe('# Deploy checks');
  });

  it('reads a CRLF document', () => {
    expect(readSkill('---\r\nname: a\r\ndescription: B.\r\n---\r\n')?.name).toBe('a');
  });
});

describe('readSkill — warnings never block', () => {
  it('warns on a name outside the allowed characters, and says what it installs as', () => {
    const skill = readSkill('---\nname: Deploy_Checks\ndescription: A thing.\n---\n');
    expect(skill?.name).toBe('Deploy_Checks');
    expect(skill?.warnings).toHaveLength(1);
    expect(skill?.warnings[0]?.field).toBe('name');
    expect(skill?.warnings[0]?.message).toContain('deploy-checks');
  });

  it('warns on a description over the limit, with the count', () => {
    const long = 'x'.repeat(DESCRIPTION_MAX + 12);
    const skill = readSkill(`---\nname: a\ndescription: ${long}\n---\n`);
    expect(skill?.warnings[0]?.field).toBe('description');
    expect(skill?.warnings[0]?.message).toContain(String(DESCRIPTION_MAX + 12));
  });

  it('does not warn at exactly the limit', () => {
    const skill = readSkill(`---\nname: a\ndescription: ${'x'.repeat(DESCRIPTION_MAX)}\n---\n`);
    expect(skill?.warnings).toEqual([]);
  });

  it('warns when tags is a scalar rather than a list', () => {
    const skill = readSkill('---\nname: a\ndescription: B.\ntags: ops\n---\n');
    expect(skill?.warnings[0]?.field).toBe('tags');
  });

  it('reports every breach, not the first', () => {
    const skill = readSkill(`---\nname: Bad_Name\ndescription: ${'x'.repeat(DESCRIPTION_MAX + 1)}\n---\n`);
    expect(skill?.warnings.map((w) => w.field)).toEqual(['name', 'description']);
  });
});

describe('skillSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(skillSlug('Deploy_Checks')).toBe('deploy-checks');
  });

  it('collapses runs and trims the edges', () => {
    expect(skillSlug('  Deploy   my __ checks!! ')).toBe('deploy-my-checks');
  });

  it('leaves an already-valid name alone', () => {
    expect(skillSlug('deploy-checks')).toBe('deploy-checks');
  });

  it('keeps digits', () => {
    expect(skillSlug('phase-2-checks')).toBe('phase-2-checks');
  });

  /*
   * A name with nothing usable in it answers empty rather than inventing one:
   * the caller refuses the install, which is a better answer than a directory
   * called `skill-1`.
   */
  it('answers empty when nothing survives', () => {
    expect(skillSlug('!!!')).toBe('');
  });
});

/**
 * The head/body split, which exists for COST rather than tidiness: the pane
 * re-derives the tab's name on every save and `body` is a copy of the whole
 * document. What is worth asserting is that the two agree about where the block
 * ends — they used to find the closing fence two different ways, and an exact
 * `indexOf('---')` misses a fence written `--- `.
 */
describe('readSkillHead and readSkill agree', () => {
  it('the head carries no body at all', () => {
    const head = readSkillHead(minimal);
    expect(head).toBeDefined();
    expect('body' in (head ?? {})).toBe(false);
  });

  it('every other field is identical', () => {
    const head = readSkillHead(minimal);
    const full = readSkill(minimal);
    expect(full).toEqual({ ...head, body: '# Deploy checks' });
  });

  it('both refuse the same non-skill', () => {
    expect(readSkillHead('# notes\n')).toBeUndefined();
    expect(readSkill('# notes\n')).toBeUndefined();
  });

  it('finds the body past a fence with trailing whitespace', () => {
    const text = ['--- ', 'name: a', 'description: B.', '---  ', '', 'body here'].join('\n');
    expect(readSkill(text)?.body).toBe('body here');
  });

  it('finds the body past leading blank lines', () => {
    expect(readSkill(`\n\n${minimal}`)?.body).toBe('# Deploy checks');
  });

  /*
   * The bound is what keeps a long scratch pad cheap to type in: without it an
   * unterminated fence rescans every line on every keystroke.
   */
  it('gives up on a fence further away than the limit', () => {
    const padding = Array.from({ length: FENCE_SEARCH_LIMIT + 5 }, () => 'x').join('\n');
    expect(readSkillHead(`---\nname: a\ndescription: B.\n${padding}\n---\n`)).toBeUndefined();
  });

  it('still finds one just inside the limit', () => {
    const padding = Array.from({ length: FENCE_SEARCH_LIMIT - 4 }, () => 'note: x').join('\n');
    expect(readSkillHead(`---\nname: a\ndescription: B.\n${padding}\n---\n`)?.name).toBe('a');
  });
});
