import { useEffect, useState, type ReactElement } from 'react';
import { IconRotate } from '@tabler/icons-react';
import { Field, IconButton, Select, Switch, type SelectOption } from '@shepherd/ui';
import type { SettingSpec, SettingValue } from '@shepherd/sdk';

/**
 * One spec, one row — and the only file in the app that knows a `type` means a
 * control.
 *
 * Everything else in this feature treats a setting as data: the manifest declares
 * it, the registry validates it, the bridge carries it. The mapping from "this is
 * an enum" to "this is a `Select`" happens exactly here, which is what makes
 * adding a widget kind a change to one file rather than a change to every
 * extension that wanted one.
 */

export interface SettingRowProps {
  readonly spec: SettingSpec;
  readonly value: SettingValue;
  /** Nothing is stored — so no reset affordance. */
  readonly isDefault: boolean;
  /** Resolved `choicesFrom` options. Absent while they are still being asked for. */
  readonly choices?: readonly SelectOption[];
  readonly busy?: boolean;
  /**
   * Why the choices could not be fetched.
   *
   * The row degrades to free text rather than becoming unreachable: a vendor that
   * cannot be asked must not turn a stored value into one the user can neither see
   * nor undo.
   */
  readonly choicesError?: string;
  /** A failed write, kept visible on the row that caused it. */
  readonly error?: string;
  readonly onChange: (next: SettingValue) => void;
  readonly onReset: () => void;
}

export function SettingRow(props: SettingRowProps): ReactElement {
  const { spec, value, isDefault, choices, busy, choicesError, error, onChange, onReset } = props;

  return (
    <div className="sh-setting" data-key={spec.key} data-default={isDefault ? 'true' : undefined}>
      <div className="sh-setting__text">
        <label className="sh-setting__label" htmlFor={controlId(spec.key)}>
          {spec.label}
        </label>
        {spec.description !== undefined && <p className="sh-setting__description">{spec.description}</p>}
        {/*
          A failed write says so on the row that caused it, not in a console the
          user cannot see — "the setting did not stick" has no other way to be
          noticed, since the value snaps back to what main still holds.
        */}
        {error !== undefined && <p className="sh-setting__error">{error}</p>}
      </div>
      <div className="sh-setting__control">
        <Control
          spec={spec}
          value={value}
          choices={choices}
          busy={busy === true}
          choicesError={choicesError}
          onChange={onChange}
        />
        {/*
          Only for a value the user actually changed. A reset beside every row
          would be a button that mostly does nothing, and "is this mine or the
          app's" is exactly what its presence answers.
        */}
        {!isDefault && (
          <IconButton
            icon={IconRotate}
            size="sm"
            label={`Reset ${spec.label} to its default`}
            title="Reset to default"
            data-testid="setting-reset"
            onClick={onReset}
          />
        )}
      </div>
    </div>
  );
}

/** A stable id per key, so the label points at its own control. */
function controlId(key: string): string {
  return `setting-${key}`;
}

function Control({
  spec,
  value,
  choices,
  busy,
  choicesError,
  onChange,
}: {
  readonly spec: SettingSpec;
  readonly value: SettingValue;
  readonly choices: readonly SelectOption[] | undefined;
  readonly busy: boolean;
  readonly choicesError: string | undefined;
  readonly onChange: (next: SettingValue) => void;
}): ReactElement {
  if (spec.type === 'boolean') {
    return (
      <Switch
        id={controlId(spec.key)}
        checked={value === true}
        label={spec.label}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (spec.type === 'enum' && choicesError === undefined) {
    const options: readonly SelectOption[] = choices ?? spec.choices ?? [];
    return (
      <Select
        value={typeof value === 'string' ? value : null}
        options={options}
        label={spec.label}
        nullable={spec.nullable === true}
        // Busy only while a DYNAMIC list is outstanding. A static `choices` list
        // is in the spec we already have, so it can never be waiting.
        busy={busy && spec.choicesFrom !== undefined}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (spec.type === 'number') {
    return (
      <NumberField
        id={controlId(spec.key)}
        spec={spec}
        value={typeof value === 'number' ? value : null}
        onChange={onChange}
      />
    );
  }

  // `string`, `path`, and the degraded `enum` whose vendor could not be asked.
  return (
    <TextField
      id={controlId(spec.key)}
      spec={spec}
      value={typeof value === 'string' ? value : ''}
      message={choicesError}
      onChange={onChange}
    />
  );
}

/**
 * A text control that reports on every keystroke, over a value main owns.
 *
 * The local copy exists because the round trip is asynchronous: typing straight
 * into a field whose value came back from the bridge drops characters entered
 * while a write is in flight. It re-syncs when main's value changes under it,
 * which is how a change made in the CLI reaches a field nobody is typing in.
 */
function TextField({
  id,
  spec,
  value,
  message,
  onChange,
}: {
  readonly id: string;
  readonly spec: SettingSpec;
  readonly value: string;
  readonly message: string | undefined;
  readonly onChange: (next: SettingValue) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field
      id={id}
      value={draft}
      invalid={message !== undefined}
      message={message}
      placeholder={spec.placeholder}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}

function NumberField({
  id,
  spec,
  value,
  onChange,
}: {
  readonly id: string;
  readonly spec: SettingSpec;
  readonly value: number | null;
  readonly onChange: (next: SettingValue) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  return (
    <Field
      id={id}
      type="number"
      value={draft}
      min={spec.min}
      max={spec.max}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        /**
         * An unparseable field reports NOTHING rather than reporting `NaN`.
         *
         * Half-typed is a real state — an empty box on the way to a number, a
         * lone `-` — and a write per keystroke would refuse each of them loudly
         * while the user is still typing. The registry would reject `NaN`
         * anyway; this keeps the row quiet until there is a value to send.
         */
        if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}
