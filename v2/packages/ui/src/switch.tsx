import type { ReactElement } from 'react';
import { cn } from './cn.ts';

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** The accessible name. Required — a switch with no name is a mystery toggle. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/**
 * The boolean control — bought by the settings screen's `boolean` row, which had
 * nothing to draw itself with.
 *
 * A `<button role="switch">` rather than a Radix import, and rather than a `div`:
 * `aria-checked` on a button IS the whole accessible contract, and Space/Enter
 * are the platform's. A div would need both re-implemented, and a dependency
 * would be a dependency for one attribute.
 *
 * Not a checkbox, deliberately. A checkbox is a value you are submitting; a
 * switch takes effect when you flip it, which is what every row in this app's
 * settings does.
 */
export function Switch({ checked, onChange, label, disabled = false, id, className }: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid="switch"
      className={cn('sh-ui-switch', className)}
      onClick={() => {
        // Guarded as well as `disabled`: a click can be dispatched
        // programmatically at a disabled button, and a settings write is not
        // something to do on a technicality.
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="sh-ui-switch__knob" aria-hidden="true" />
    </button>
  );
}
