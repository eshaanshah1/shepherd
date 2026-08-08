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
    // mechanism compose: a theme re-declaring `--sh-surface-raised` moves this
    // with it, where a baked hex would freeze it to the built-in palette.
    expect(style.getPropertyValue('--sh-surface')).toBe('var(--sh-surface-raised)');
    expect(style.getPropertyValue('--sh-surface-sunken')).toBe('transparent');
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

  it('is the soft surface: 16px radius from the token, and no border', () => {
    const rule = rulesMentioning('sh-ui-composer').find(
      (candidate) => candidate.selectorText === '.sh-ui-composer',
    );
    expect(rule?.style.getPropertyValue('border-radius')).toBe('var(--sh-radius-soft)');
    // Rule 2: the luminance step IS the elevation, and there is no second one.
    expect(rule?.style.getPropertyValue('box-shadow')).toBe('');
    expect(rule?.style.getPropertyValue('border')).toBe('');
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
