import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { rulesMentioning } from './css-rules.ts';
import { Composer } from './composer.tsx';
import { Field } from './field.tsx';
import './styles.css';

const composer = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('.sh-ui-composer');
  if (!found) throw new Error('no composer rendered');
  return found;
};

describe('Composer', () => {
  /**
   * The reason this component exists. Spec §2's scoped re-declaration: a surface
   * that needs a different fill re-declares the GENERIC role on its own subtree,
   * never a parallel `--sh-composer-*` family (which is what pane chrome does
   * today, and it needs every component inside to know where it is).
   */
  it('re-declares the generic roles for its subtree', () => {
    const dom = mount(<Composer>body</Composer>);
    const style = getComputedStyle(composer(dom.container));

    // Emitted as REFERENCES, not resolved colours — that is what makes the
    // mechanism compose: a theme re-declaring `--sh-raised` moves this
    // with it, where a baked hex would freeze it to the built-in palette.
    expect(style.getPropertyValue('--sh-surface')).toBe('var(--sh-well)');
    expect(style.getPropertyValue('--sh-sunken')).toBe('transparent');
    expect(style.getPropertyValue('--sh-line')).toBe('transparent');
  });

  it('re-declares them on the CONTAINER, so anything dropped inside inherits it', () => {
    // A `<Field>` inside needs no prop and no knowledge of where it is: it is
    // still asking for the generic roles, and they now mean something else.
    const dom = mount(
      <Composer>
        <Field placeholder="Name this work" />
      </Composer>,
    );
    const field = dom.container.querySelector('.sh-ui-field__control');
    expect(field?.closest('.sh-ui-composer')).toBe(composer(dom.container));
    // Nothing was passed to the field to make this happen.
    expect(field?.getAttribute('data-variant')).toBe('bordered');
  });

  it('is a WELL: the soft radius, and a real edge on it', () => {
    // It used to be `raised` with no border — a menu's treatment, which is right
    // for something that floats over a surface and wrong for something you
    // WRITE on. §2 gives the composer its own luminance step and §4 gives a well
    // its own edge: `lineStrong`, because a well is a box with four corners and
    // at `line` it disappears into the chrome behind the scrim.
    const rule = rulesMentioning('sh-ui-composer').find(
      (candidate) => candidate.selectorText === '.sh-ui-composer',
    );
    expect(rule?.style.getPropertyValue('border-radius')).toBe('var(--sh-radius-soft)');
    expect(rule?.style.getPropertyValue('background')).toBe('var(--sh-well)');
    expect(rule?.style.getPropertyValue('border')).toContain('var(--sh-line-strong)');
    // …and the INNER hairlines stay off, which is what the re-declaration above
    // buys: inside a well, space is the structure.
    expect(rule?.style.getPropertyValue('--sh-line')).toBe('transparent');
  });

  it('composes its padding from the space scale rather than typing a number', () => {
    const rule = rulesMentioning('sh-ui-composer').find(
      (candidate) => candidate.selectorText === '.sh-ui-composer',
    );
    const padding = rule?.style.getPropertyValue('padding') ?? '';
    expect(padding).toContain('var(--sh-space-xl)');
    expect(padding).toContain('var(--sh-space-lg)');
    expect(padding).not.toMatch(/\d+px/);
  });

  it('names its scope for the inspector, spreads props and forwards a ref', () => {
    let node: HTMLDivElement | null = null;
    const dom = mount(
      <Composer
        data-testid="task-composer"
        ref={(element) => {
          node = element;
        }}
      >
        body
      </Composer>,
    );
    const el = composer(dom.container);
    expect(el.dataset.surface).toBe('composer');
    expect(el.getAttribute('data-testid')).toBe('task-composer');
    expect(node).toBe(el);
  });
});
