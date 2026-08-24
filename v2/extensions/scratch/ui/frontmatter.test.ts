import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildFrontmatterDecorations, frontmatterSpan } from './frontmatter.ts';

/**
 * No language extension, deliberately.
 *
 * This is the one construct in this editor found by POSITION rather than by the
 * syntax tree — frontmatter is not markdown — so a parser in the state would
 * prove nothing about it either way.
 */
function stateOf(doc: string, caret?: number): EditorState {
  return EditorState.create({ doc, ...(caret === undefined ? {} : { selection: { anchor: caret } }) });
}

/** Every line class in the set, so a row's treatment is readable. */
function lineClasses(doc: string, caret?: number): string[] {
  const out: string[] = [];
  buildFrontmatterDecorations(stateOf(doc, caret)).between(0, doc.length + 1, (from, to, deco) => {
    const spec = deco.spec as { class?: string };
    if (from === to && spec.class !== undefined) out.push(spec.class);
  });
  return out;
}

/** Every mark/replace range, as `[from, to, class]`. */
function marks(doc: string, caret?: number): [number, number, string][] {
  const out: [number, number, string][] = [];
  buildFrontmatterDecorations(stateOf(doc, caret)).between(0, doc.length + 1, (from, to, deco) => {
    if (to > from) out.push([from, to, (deco.spec as { class?: string }).class ?? 'REPLACE']);
  });
  return out;
}

const SKILL = ['---', 'name: deploy-checks', 'description: Runs the suite.', '---', '', '# Deploy checks'].join('\n');

describe('frontmatterSpan', () => {
  it('finds the block a document opens with', () => {
    const span = frontmatterSpan(stateOf(SKILL));
    expect(span?.open).toBe(0);
    expect(span?.close).toBe(SKILL.indexOf('---', 1));
  });

  it('skips leading blank lines', () => {
    expect(frontmatterSpan(stateOf(`\n\n${SKILL}`))?.open).toBe(2);
  });

  it('finds none in a document that does not open with a fence', () => {
    expect(frontmatterSpan(stateOf('# hi\n\n---\nname: a\n---\n'))).toBeUndefined();
  });

  /*
   * Somebody part-way through typing. Styling an unterminated block would make
   * the whole document flicker into a field block as they went.
   */
  it('finds none while the fence is still open', () => {
    expect(frontmatterSpan(stateOf('---\nname: a\n'))).toBeUndefined();
  });

  it('finds an empty block', () => {
    expect(frontmatterSpan(stateOf('---\n---\n'))?.close).toBe(4);
  });
});

describe('the field block, with the caret out of it', () => {
  const away = SKILL.length;

  it('collapses both fences', () => {
    expect(lineClasses(SKILL, away).filter((name) => name === 'sh-scratch-fm-fence')).toHaveLength(2);
  });

  it('marks every key row', () => {
    expect(lineClasses(SKILL, away).filter((name) => name === 'sh-scratch-fm-row')).toHaveLength(2);
  });

  it('closes the block with a hairline on the last row only', () => {
    expect(lineClasses(SKILL, away).filter((name) => name === 'sh-scratch-fm-last')).toHaveLength(1);
  });

  it('styles the key and hides the colon after it', () => {
    const drawn = marks(SKILL, away);
    expect(drawn).toContainEqual([4, 8, 'sh-scratch-fm-key']);
    // `name` ends at 8, the value starts at 10: `:` and one space.
    expect(drawn).toContainEqual([8, 10, 'REPLACE']);
  });

  it('sets an identifier value in mono and prose in sans', () => {
    const drawn = marks(SKILL, away).filter(([, , cls]) => cls.includes('fm-value'));
    expect(drawn[0]?.[2]).toBe('sh-scratch-fm-value sh-scratch-fm-id');
    expect(drawn[1]?.[2]).toBe('sh-scratch-fm-value');
  });

  it('draws nothing at all outside the block', () => {
    const body = SKILL.indexOf('# Deploy');
    expect(marks(SKILL, away).every(([, to]) => to <= body)).toBe(true);
  });

  it('leaves a valueless key without a value mark', () => {
    const doc = '---\nname:\n---\n';
    expect(marks(doc, doc.length).filter(([, , cls]) => cls.includes('fm-value'))).toEqual([]);
  });

  it('treats a folded block’s continuation as a row of its own', () => {
    const doc = ['---', 'description: >', '  one', '  two', '---'].join('\n');
    expect(lineClasses(doc, doc.length).filter((name) => name === 'sh-scratch-fm-cont')).toHaveLength(2);
  });
});

describe('the field block, with the caret in it', () => {
  /*
   * Per LINE, not per block: a caret in the description must not unstyle the name
   * three rows up. `live-preview.ts` sets the same rule for every other block
   * construct.
   */
  it('keeps the fences collapsed while the caret is on a key row', () => {
    const caret = SKILL.indexOf('deploy-checks');
    expect(lineClasses(SKILL, caret).filter((name) => name === 'sh-scratch-fm-fence')).toHaveLength(2);
  });

  it('reveals a fence the caret lands on, and only that one', () => {
    const fences = lineClasses(SKILL, 1).filter((name) => name === 'sh-scratch-fm-fence');
    expect(fences).toHaveLength(1);
  });

  /*
   * The colon comes back under the caret and the row's colour does not. The rule
   * is that characters under the caret must not move; a colour is not a
   * character, and a vanished colon shifts the value sideways mid-word.
   */
  it('brings the colon back on the caret’s own row but keeps the row styled', () => {
    const caret = SKILL.indexOf('deploy-checks');
    const row = stateOf(SKILL, caret).doc.lineAt(caret);
    const hiddenOnThisRow = marks(SKILL, caret).filter(
      ([from, to, cls]) => cls === 'REPLACE' && from >= row.from && to <= row.to,
    );
    expect(hiddenOnThisRow).toEqual([]);
    expect(lineClasses(SKILL, caret)).toContain('sh-scratch-fm-row');
  });

  it('keeps hiding the colon on rows the caret is not on', () => {
    const caret = SKILL.indexOf('deploy-checks');
    const hidden = marks(SKILL, caret).filter(([, , cls]) => cls === 'REPLACE');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.[0]).toBeGreaterThan(caret);
  });
});

describe('the field block, absent', () => {
  it('draws nothing in an ordinary scratch pad', () => {
    expect(marks('# notes\n\nsome text\n')).toEqual([]);
    expect(lineClasses('# notes\n\nsome text\n')).toEqual([]);
  });

  it('draws nothing in an empty document', () => {
    expect(lineClasses('')).toEqual([]);
  });
});
