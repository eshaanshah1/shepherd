import type { ReactElement } from 'react';
import { cn } from './cn.ts';

/** The check itself. Named once so the component and `checkboxDOM` cannot differ. */
const CHECK_PATH = 'M2.5 6.2 L4.8 8.5 L9.5 3.6';

export interface CheckboxProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** The accessible name. Required — an unnamed box is a mystery toggle. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/**
 * The other boolean control, and `Switch`'s doc comment already drew the line:
 * a switch takes effect when you flip it, a checkbox is a VALUE you are
 * submitting. That line is why this exists rather than reusing `Switch`.
 *
 * Its first consumer is a task list in a scratch pane, where the value being
 * submitted is a character in a document — the `x` inside `- [x]`. A switch
 * there would be wrong twice: it would read as a setting, and a row of settings
 * is not what a list of things to do looks like.
 *
 * A `<button role="checkbox">` for the reason `Switch` is a button: `aria-checked`
 * on a button IS the accessible contract, Space and Enter are the platform's, and
 * a real `<input type="checkbox">` would bring a browser-drawn box that no token
 * can reach. The mark is an inline SVG rather than a glyph font or a `::after`
 * border trick, so its stroke scales with the box and it inherits `currentColor`.
 */
export function Checkbox({ checked, onChange, label, disabled = false, id, className }: CheckboxProps): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid="checkbox"
      className={cn('sh-ui-checkbox', className)}
      onClick={() => {
        // Guarded as well as `disabled`, for `Switch`'s reason: a click can be
        // dispatched programmatically at a disabled button.
        if (!disabled) onChange(!checked);
      }}
    >
      {/*
        Drawn only when checked, and `aria-hidden` because the button already
        says so — a second announcement is the status-word-beside-the-mark
        refusal wearing a different hat.
      */}
      <svg className="sh-ui-checkbox__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d={CHECK_PATH} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * The same control, built as DOM rather than rendered as React.
 *
 * For a consumer that has no React tree to render into — a CodeMirror widget in
 * the scratch pane is the first, and widgets are created and destroyed on scroll,
 * so a React root per checkbox would mean mounting and unmounting dozens of them
 * while the user drags a scrollbar.
 *
 * It exists HERE, beside the component, so the markup has one home. The two are
 * asserted to agree in `checkbox.test.tsx`; a class name renamed in one and not
 * the other is a failing test rather than an unstyled box in a pane nobody
 * opened this week.
 *
 * The caller owns behaviour: this attaches no listener, because the one consumer
 * needs the click to become a document edit rather than a state change.
 */
export function checkboxDOM(options: { checked: boolean; label: string; className?: string }): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'checkbox');
  button.setAttribute('aria-checked', String(options.checked));
  button.setAttribute('aria-label', options.label);
  button.title = options.label;
  button.className = cn('sh-ui-checkbox', options.className);

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('class', 'sh-ui-checkbox__mark');
  mark.setAttribute('viewBox', '0 0 12 12');
  mark.setAttribute('aria-hidden', 'true');
  mark.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', CHECK_PATH);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  mark.append(path);
  button.append(mark);
  return button;
}
