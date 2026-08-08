import { describe, expect, it } from 'vitest';
import { mount } from './test-dom.ts';
import { Field, type FieldSize, type FieldVariant } from './field.tsx';
import './styles.css';

const VARIANTS: FieldVariant[] = ['bordered', 'bare'];
const SIZES: FieldSize[] = ['sm', 'md'];

const control = (container: HTMLElement): HTMLInputElement => {
  const found = container.querySelector<HTMLInputElement>('.sh-ui-field__control');
  if (!found) throw new Error('no field rendered');
  return found;
};

describe('Field', () => {
  it('renders every variant with its class', () => {
    for (const variant of VARIANTS) {
      const dom = mount(<Field variant={variant} />);
      expect(control(dom.container).className, variant).toContain(
        `sh-ui-field__control--${variant}`,
      );
      expect(control(dom.container).dataset.variant, variant).toBe(variant);
    }
  });

  it('renders every size with its class', () => {
    for (const size of SIZES) {
      const dom = mount(<Field size={size} />);
      expect(control(dom.container).className, size).toContain(`sh-ui-field__control--${size}`);
      expect(control(dom.container).dataset.size, size).toBe(size);
    }
  });

  it('defaults to the bordered instrument at md', () => {
    const dom = mount(<Field />);
    expect(control(dom.container).className).toContain('sh-ui-field__control--bordered');
    expect(control(dom.container).className).toContain('sh-ui-field__control--md');
  });

  it('bordered is a recessed well; bare has no surface of its own', () => {
    // Flock's split, made structural: instruments get borders, writing surfaces
    // get space. `bare` carries no colour at all, which is what lets a Composer's
    // scoped re-declaration reach it.
    const bordered = mount(<Field variant="bordered" />);
    expect(getComputedStyle(control(bordered.container)).background).toBe(
      'var(--sh-surface-sunken)',
    );

    const bare = mount(<Field variant="bare" />);
    // jsdom normalises `transparent` to its rgba form; either spelling is the
    // same declaration and the point is that `bare` paints nothing of its own.
    expect(getComputedStyle(control(bare.container)).background).toBe('rgba(0, 0, 0, 0)');
  });

  it('marks invalid on the wrapper and on the control, and wires up the message', () => {
    // An ember border with nothing to read says something is wrong and not what —
    // and to anyone who cannot see the red it says nothing at all.
    const dom = mount(<Field invalid message="That path is not a git work tree." />);
    const el = control(dom.container);
    expect(el.closest('.sh-ui-field')?.getAttribute('data-invalid')).toBe('true');
    expect(el.getAttribute('aria-invalid')).toBe('true');

    const message = dom.container.querySelector('.sh-ui-field__message');
    expect(message?.textContent).toBe('That path is not a git work tree.');
    expect(el.getAttribute('aria-describedby')).toBe(message?.id);
  });

  it('renders no message slot when there is no message', () => {
    const dom = mount(<Field />);
    expect(dom.container.querySelector('.sh-ui-field__message')).toBeNull();
    expect(control(dom.container).hasAttribute('aria-describedby')).toBe(false);
  });

  it('puts rest, className and ref on the control rather than on the wrapper', () => {
    // Everything a caller means by "this field" is about the thing you type in.
    let node: HTMLInputElement | null = null;
    const dom = mount(
      <Field
        data-testid="repo-path"
        placeholder="~/dev"
        className="sh-composer-repo"
        ref={(element) => {
          node = element;
        }}
      />,
    );
    const el = control(dom.container);
    expect(el.getAttribute('data-testid')).toBe('repo-path');
    expect(el.getAttribute('placeholder')).toBe('~/dev');
    expect(el.className).toContain('sh-composer-repo');
    expect(node).toBe(el);
  });
});
