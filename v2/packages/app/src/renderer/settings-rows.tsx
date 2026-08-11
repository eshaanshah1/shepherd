import { useEffect, useState, type ReactElement } from 'react';
import { IconRotate } from '@tabler/icons-react';
import { Button, Field, IconButton, Select, Switch, type SelectOption } from '@shepherd/ui';
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
 *
 * The row is a two-track GRID (`settings.css`): the text takes what is left and the
 * control takes a fixed track. That is what makes a label and its control read as a
 * pair — as a flex row justified apart, the control travelled to the window's right
 * edge and the page read as two unrelated columns.
 */

export interface SettingRowProps {
  readonly spec: SettingSpec;
  readonly value: SettingValue;
  /** Nothing is stored — so no changed marker and no reset. */
  readonly isDefault: boolean;
  /** Resolved `choicesFrom` options. Absent while they are still being asked for. */
  readonly choices?: readonly SelectOption[];
  readonly busy?: boolean;
  /**
   * Why the choices could not be fetched.
   *
   * The row keeps its SHAPE and de-escalates: a disabled select, one plain
   * sentence, a retry, and this string behind a closed disclosure. It does not
   * become a different control, and it carries no ember — the card's header band
   * owns that, once.
   */
  readonly choicesError?: string;
  /**
   * This row's choices depend on a row above that has not resolved.
   *
   * Not an error: which models exist depends on which agent, so a model row under
   * an unresolved agent row is waiting rather than broken.
   */
  readonly waiting?: boolean;
  /** Who owns this page, for the one sentence a degraded row says. */
  readonly owner?: string;
  /** A failed write, kept visible on the row that caused it. */
  readonly error?: string;
  readonly onChange: (next: SettingValue) => void;
  readonly onReset: () => void;
  /** Ask for this row's choices again. The user's retry, never a loop. */
  readonly onRetryChoices?: () => void;
}

export function SettingRow(props: SettingRowProps): ReactElement {
  const { spec, value, isDefault, choices, busy, choicesError, waiting, owner, error, onChange, onReset } = props;
  const degraded = choicesError !== undefined;

  return (
    <div className="sh-setting" data-key={spec.key} data-default={isDefault ? 'true' : undefined}>
      <div className="sh-setting__text">
        <div className="sh-setting__label-line">
          <label className="sh-setting__label" htmlFor={controlId(spec.key)}>
            {spec.label}
          </label>
          {/*
            The changed marker — `prompt`, the "here, now" role.

            A modified row used to be signalled only by the reset button appearing,
            which answers "can I undo this" rather than "is this value mine". The
            word is mono at nano because it is a state the machine is reporting, not
            a label the app chose.
          */}
          {!isDefault && (
            <>
              <span className="sh-setting__changed-dot" aria-hidden="true" />
              <span className="sh-setting__changed" data-testid="setting-changed">
                changed
              </span>
            </>
          )}
        </div>
        {spec.description !== undefined && <p className="sh-setting__description">{spec.description}</p>}
        {/*
          A failed write says so on the row that caused it, not in a console the
          user cannot see — "the setting did not stick" has no other way to be
          noticed, since the value snaps back to what main still holds.
        */}
        {error !== undefined && <p className="sh-setting__error">{error}</p>}
      </div>
      <div className="sh-setting__control">
        <div className="sh-setting__control-line">
          <Control
            spec={spec}
            value={value}
            choices={choices}
            busy={busy === true}
            degraded={degraded}
            waiting={waiting === true}
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
        {degraded && <Degraded owner={owner} message={choicesError} onRetry={props.onRetryChoices} />}
        {!degraded && waiting === true && (
          <span className="sh-setting__waiting" data-testid="setting-waiting">
            Waiting on an agent above.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The sentinel a disabled, degraded `Select` shows instead of an em dash.
 *
 * Never written: the control is disabled, so `onChange` cannot fire.
 */
const NO_CHOICES = '\u0000no-choices';

/** A stable id per key, so the label points at its own control. */
function controlId(key: string): string {
  return `setting-${key}`;
}

/**
 * What a failed `choicesFrom` says, and what it does NOT say.
 *
 * One sentence in plain language, a retry, and the command's own words behind a
 * disclosure that is closed on mount. What it replaces: an ember-outlined empty
 * text box per row with `"agents.quickModelChoices" failed: invalid-args: expected
 * object, got undefined` under each of them — the loudest treatment in the palette,
 * repeated, for a message nobody outside this repo can act on.
 *
 * The raw string is never deleted. It is the only place the failing command's own
 * words are visible, and a failure whose text nobody can reach is a failure nobody
 * can report.
 */
function Degraded({
  owner,
  message,
  onRetry,
}: {
  readonly owner: string | undefined;
  readonly message: string;
  readonly onRetry: (() => void) | undefined;
}): ReactElement {
  return (
    <>
      <div className="sh-setting__degraded">
        <span className="sh-setting__degraded-text" data-testid="setting-degraded">
          {owner ?? 'This extension'} couldn’t list its choices.
        </span>
        {onRetry !== undefined && (
          <Button type="button" size="sm" variant="default" data-testid="setting-retry" onClick={onRetry}>
            retry
          </Button>
        )}
      </div>
      <details className="sh-setting__raw" data-testid="setting-raw">
        <summary>details</summary>
        <p>{message}</p>
      </details>
    </>
  );
}

function Control({
  spec,
  value,
  choices,
  busy,
  degraded,
  waiting,
  onChange,
}: {
  readonly spec: SettingSpec;
  readonly value: SettingValue;
  readonly choices: readonly SelectOption[] | undefined;
  readonly busy: boolean;
  readonly degraded: boolean;
  readonly waiting: boolean;
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

  if (spec.type === 'enum') {
    const options: readonly SelectOption[] = choices ?? spec.choices ?? [];
    /**
     * A degraded enum stays a `Select` — disabled, reading its own emptiness.
     *
     * Falling back to a text field made the row a different control, so the page
     * changed shape on a failure and the user was invited to type a model id by
     * hand. `No choices` is what there is; `Default` is what a waiting row will
     * resolve to once the row above it does.
     */
    if (degraded) {
      /*
        Disabled, and showing THE STORED VALUE when there is one.

        The handoff says this reads `No choices`, and it does — but only when
        nothing is stored. With a value set, `No choices` would hide it: the row
        would show neither what is configured nor a way to see it, so a model
        somebody chose last week becomes invisible and un-undoable the moment its
        vendor cannot be asked. That is the exact regression the two tests on this
        path were placed to prevent ("a stored value you can neither see nor change
        is a setting you cannot undo"), and it is a strictly better failure state
        than the mock's for no cost to any other part of §5.

        The value rides in as the one option because `Select` draws the current
        option's label. Nothing can select it — a disabled trigger never opens, so
        `onChange` cannot fire and the sentinel cannot reach a write.
      */
      const shown = typeof value === 'string' && value !== '' ? value : null;
      return (
        <Select
          value={shown ?? NO_CHOICES}
          options={[{ value: shown ?? NO_CHOICES, label: shown ?? 'No choices' }]}
          label={spec.label}
          disabled
          onChange={() => {}}
        />
      );
    }
    if (waiting) {
      // `nullable` with a null value already reads `Default`, which is exactly what
      // this row will resolve to once the row above it does.
      return <Select value={null} options={[]} label={spec.label} nullable disabled onChange={() => {}} />;
    }
    return (
      <Select
        value={typeof value === 'string' ? value : null}
        options={options}
        label={spec.label}
        nullable={spec.nullable === true}
        // Busy only while a DYNAMIC list is outstanding. A static `choices` list is
        // in the spec we already have, so it can never be waiting.
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

  // `string` and `path`.
  return (
    <TextField
      id={controlId(spec.key)}
      spec={spec}
      value={typeof value === 'string' ? value : ''}
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
  onChange,
}: {
  readonly id: string;
  readonly spec: SettingSpec;
  readonly value: string;
  readonly onChange: (next: SettingValue) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field
      id={id}
      value={draft}
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
