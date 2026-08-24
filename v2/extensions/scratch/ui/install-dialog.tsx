import { useEffect, useState, type ReactElement } from 'react';
import { Button, Checkbox, Modal, Select, type SelectOption } from '@shepherd/ui';
import { CLAUDE_CODE, PROVIDER_LABELS, providers as allProviders, skillPath } from '../src/provider.ts';
import type { SkillTarget } from '../src/targets.ts';

/**
 * Where a skill goes, asked once.
 *
 * Two questions and a path. The path is the thing worth reading — the level and
 * the provider are both only interesting in that they decide it — so it sits
 * directly under the heading and updates with either answer.
 *
 * **One primary, and it is the install.** The strip's control is `secondary`
 * because a strip has three tabs on it already; this surface has nothing else on
 * it, so this is where the one wool fill in the flow belongs.
 */

/** The braille frame `@shepherd/ui` uses everywhere a control is busy. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface InstallDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The skill's name, for the path preview. Already the document's own. */
  readonly name: string;
  /** From `scratch.skillTargets`. Empty while the answer is in flight. */
  readonly targets: readonly SkillTarget[];
  readonly busy?: boolean;
  /** A refusal from the last attempt. `null` clears the line. */
  readonly problem?: string | null;
  /**
   * The install refused because something is already there, so the one thing the
   * user can do about it is offered — and only then.
   */
  readonly canOverwrite?: boolean;
  readonly onInstall: (choice: { target: string; providers: readonly string[]; overwrite: boolean }) => void;
}

export function InstallDialog({
  open,
  onOpenChange,
  name,
  targets,
  busy = false,
  problem = null,
  canOverwrite = false,
  onInstall,
}: InstallDialogProps): ReactElement {
  const [target, setTarget] = useState<string | null>(null);
  const [chosen, setChosen] = useState<readonly string[]>([CLAUDE_CODE]);
  const [frame, setFrame] = useState(0);

  /*
   * The first target, once they arrive, and never again.
   *
   * `targets[0]` is the user level (`targets.ts` orders it first deliberately),
   * so this lands on the answer that is right most of the time. Keyed on the
   * FIRST target rather than the array: the list is rebuilt on every render of
   * the parent, and depending on its identity would reset a choice the user had
   * already made.
   */
  const first = targets[0]?.id;
  useEffect(() => {
    if (first !== undefined) setTarget((current) => current ?? first);
  }, [first]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setFrame((at) => (at + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [busy]);

  const options: readonly SelectOption[] = targets.map((entry) => ({
    value: entry.id,
    // The label AND the path, because two repos can share a basename and the
    // path is the only thing that distinguishes them.
    label: entry.kind === 'user' ? `User · ${entry.display}` : `${entry.label} · ${entry.display}`,
  }));

  const root = targets.find((entry) => entry.id === target)?.root;
  /*
   * The path, from the FIRST chosen provider.
   *
   * With several ticked they differ only in that fragment, and printing every one
   * would turn the line that answers "where does this go" into a list. The first
   * is the one a reader checks; the rest follow the same shape.
   */
  const preview =
    root === undefined || name === '' ? null : skillPath(root, chosen[0] ?? CLAUDE_CODE, name);

  const toggle = (provider: string, on: boolean): void => {
    setChosen((current) =>
      on ? [...current, provider].filter((value, at, all) => all.indexOf(value) === at) : current.filter((value) => value !== provider),
    );
  };

  const ready = target !== null && chosen.length > 0 && !busy;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Install skill" size="md" className="sh-scratch-install sh-ui-modal-form">
      <div className="sh-scratch-install__head">
        <h2 className="sh-scratch-install__title">Install skill</h2>
        {/*
          The path, in mono, and it is the one line here that is machine output
          rather than something the app says. Truncated from the LEFT: the tail
          names the skill and the head is a directory prefix you already know.
        */}
        <p className="sh-scratch-install__path">{preview ?? 'Choose where this goes.'}</p>
      </div>

      <div className="sh-scratch-install__field">
        <span className="sh-scratch-install__label">Level</span>
        <Select
          label="Level"
          value={target}
          options={options}
          onChange={setTarget}
          /*
           * Busy while the list is empty AND nothing has been chosen — which is
           * the instant before `scratch.skillTargets` answers. An empty listbox
           * would read as "there is nowhere to install this", which is a
           * different and wrong answer to "the list has not arrived".
           */
          busy={targets.length === 0}
        />
      </div>

      <div className="sh-scratch-install__field">
        <span className="sh-scratch-install__label">Providers</span>
        {/*
          A checkbox list, not a select, and with one provider available that is
          the whole point: the question is plural. A dropdown would say "pick one
          of these" about a set that will grow to be ticked severally.
        */}
        <div className="sh-scratch-install__providers">
          {allProviders().map((provider) => (
            <label key={provider} className="sh-scratch-install__provider">
              <Checkbox
                label={PROVIDER_LABELS[provider] ?? provider}
                checked={chosen.includes(provider)}
                onChange={(on) => toggle(provider, on)}
              />
              <span>{PROVIDER_LABELS[provider] ?? provider}</span>
            </label>
          ))}
        </div>
      </div>

      {problem === null ? null : (
        <p className="sh-scratch-install__problem" role="alert">
          {problem}
        </p>
      )}

      <div className="sh-scratch-install__foot">
        <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {/*
          Overwrite appears ONLY after a refusal that said something is already
          there — it is not a checkbox you arm in advance. The first answer to
          "this exists" has to be no, and this is the second answer.
        */}
        {!canOverwrite ? null : (
          <Button
            variant="danger"
            size="md"
            disabled={!ready}
            onClick={() => target !== null && onInstall({ target, providers: chosen, overwrite: true })}
          >
            Replace
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          disabled={!ready}
          onClick={() => target !== null && onInstall({ target, providers: chosen, overwrite: false })}
        >
          {busy ? SPINNER[frame] : 'Install'}
        </Button>
      </div>
    </Modal>
  );
}
