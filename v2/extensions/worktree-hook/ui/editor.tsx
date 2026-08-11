import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';
import { Button, Field, Pill, Row, SectionLabel, TextArea } from '@shepherd/ui';
import { WORKTREE_HOOK_COMMANDS } from '../src/manifest.ts';

/**
 * The hook editor — a contributed settings PAGE (ADR 0033, spec 2026-08-11).
 *
 * Like the composer, it is a **consumer** and nothing more: React and four command
 * invocations, with every decision — what clears a hook, which paths exist, whether
 * a script is worth storing — on the other side of `invoke`. The repo field
 * completes through `tasks.suggestRepos`, borrowed rather than reimplemented so that
 * the repos you can hook and the repos you can put on a task are the same set,
 * spelled the same way.
 *
 * It was one `Composer` until the settings screen existed, and a composer is a
 * writing surface with no inner hairlines — which is exactly why three sections,
 * three labels and three action rows inside one 16px-radius box disappeared into
 * each other. It is now three CARDS carrying the same treatment a spec page's group
 * card has, so a contributed page and a kernel page read as the same app:
 *
 *     header band   "1 · EVERY REPO"                        $WORKTREE_DIR
 *     body          what this scope does, then its inputs, then the script well
 *     footer        [status]                        [test run]  [save]
 *
 * The numbers are the run order, which is real information the stacked layout only
 * implied. The env vars are what each scope's script can read — the one thing a
 * person writing a hook has to know and had to guess.
 */

interface StoredHook {
  readonly path: string;
  readonly script: string;
}

/**
 * A command's answer is `unknown`, and a cast is not a check.
 *
 * It crossed an IPC boundary; reading `.length` off whatever arrived is how a
 * malformed answer takes the whole page down with a `TypeError`. Anything that is
 * not a well-formed hook is dropped rather than drawn.
 */
function readHooks(value: unknown): readonly StoredHook[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, script } = entry as { path?: unknown; script?: unknown };
    if (typeof path !== 'string' || path === '' || typeof script !== 'string') return [];
    return [{ path, script }];
  });
}

interface StoredSet {
  readonly paths: readonly string[];
  readonly script: string;
}

/**
 * A set, out of an answer that crossed an IPC boundary. Anything not well-formed
 * is dropped rather than drawn — reading `.length` off whatever arrived is how a
 * malformed answer takes the whole page down with a `TypeError`.
 */
function readSets(value: unknown): readonly StoredSet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { paths, script } = entry as { paths?: unknown; script?: unknown };
    if (!Array.isArray(paths) || paths.length === 0 || typeof script !== 'string') return [];
    if (!paths.every((path: unknown) => typeof path === 'string' && path !== '')) return [];
    return [{ paths: paths as readonly string[], script }];
  });
}

/** `/src/alpha` → `alpha`, so a set reads as the directories under the task root. */
function nameOf(path: string): string {
  return path.split('/').filter((part) => part !== '').pop() ?? path;
}

function readPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path } = entry as { path?: unknown };
    if (typeof path !== 'string' || path === '' || seen.has(path)) return [];
    seen.add(path);
    return [path];
  });
}

function readScript(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const { script } = value as { script?: unknown };
  return typeof script === 'string' ? script : '';
}

/** `2` → `2 lines`; a hook is a script and its size is how many of them. */
function lineCount(script: string): string {
  const lines = script.split('\n').filter((line) => line.trim() !== '').length;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

/**
 * Which card the user is working in.
 *
 * It decides which `save` is `variant="primary"` — exactly ONE per surface, which
 * is rule 3's `notFor`. This page shipped three saves, two of them blue, so the
 * page had three "the main thing to do here" and therefore none.
 */
type Scope = 'global' | 'repo' | 'set';

export function WorktreeHookEditor({ invoke }: ExtensionViewProps): ReactElement {
  const globalId = useId();
  const pathId = useId();
  const scriptId = useId();
  const listId = useId();

  const [globalScript, setGlobalScript] = useState('');
  const [hooks, setHooks] = useState<readonly StoredHook[]>([]);
  const [path, setPath] = useState('');
  const [script, setScript] = useState('');
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  /** Per-card, so a status lands in the footer of the card that caused it. */
  const [status, setStatus] = useState<Partial<Record<Scope, string>>>({});
  const [active, setActive] = useState<Scope>('global');

  /**
   * The set section's own state. `suggestions` is deliberately SHARED with the
   * one-repo field above: `complete()` is one completion query and both fields
   * draw it through their own `<datalist>`, which a browser only shows for the
   * focused input. Two copies would be two things to keep in step for no gain.
   */
  const [sets, setSets] = useState<readonly StoredSet[]>([]);
  /** The chips — named for the store's own word for a set's identity. */
  const [members, setMembers] = useState<readonly string[]>([]);
  /** The repo path being typed, not yet a chip. */
  const [draft, setDraft] = useState('');
  const [wiringScript, setWiringScript] = useState('');
  const setPathId = useId();
  const setScriptId = useId();
  const setListId = useId();

  const refresh = async (): Promise<void> => {
    const shown = await invoke(WORKTREE_HOOK_COMMANDS.get, {});
    if (!shown.ok) {
      setStatus((was) => ({ ...was, [active]: `${shown.error.code}: ${shown.error.message}` }));
      return;
    }
    setGlobalScript(readScript(shown.value));
    setHooks(readHooks((shown.value as { repos?: unknown }).repos));
    setSets(readSets((shown.value as { sets?: unknown }).sets));
  };

  useEffect(() => {
    void refresh();
    // Once, on open. The page is unmounted when the screen closes, so opening it
    // again is a fresh read rather than a stale one kept warm.
  }, []);

  const save = async (repo: string | undefined, text: string): Promise<void> => {
    const scope: Scope = repo === undefined ? 'global' : 'repo';
    const done = await invoke(
      WORKTREE_HOOK_COMMANDS.set,
      repo === undefined ? { script: text } : { repo, script: text },
    );
    if (!done.ok) {
      setStatus((was) => ({ ...was, [scope]: `${done.error.code}: ${done.error.message}` }));
      return;
    }
    // "saved" is a lie when the script was empty, and the difference matters:
    // clearing is a delete, and a person who typed nothing by accident should
    // be told the hook is gone rather than that it is stored.
    setStatus((was) => ({ ...was, [scope]: text.trim() === '' ? 'cleared' : 'saved' }));
    await refresh();
  };

  const saveSet = async (): Promise<void> => {
    const done = await invoke(WORKTREE_HOOK_COMMANDS.set, { repos: [...members], script: wiringScript });
    if (!done.ok) {
      setStatus((was) => ({ ...was, set: `${done.error.code}: ${done.error.message}` }));
      return;
    }
    setStatus((was) => ({ ...was, set: wiringScript.trim() === '' ? 'cleared' : 'saved' }));
    await refresh();
  };

  /**
   * Run a script against a directory the user nominates — v1's "Test run".
   *
   * The directory is theirs to create and remove: an extension that made temp
   * directories would acquire a cleanup problem, and `os.tmpdir` is exactly the OS
   * API `boundaries.js` keeps out of an extension. So the prompt is the page's, and
   * an empty answer is a cancel rather than a run at `/`.
   */
  const testRun = async (scope: Scope, text: string): Promise<void> => {
    const at = window.prompt('Run it in which directory?', '');
    if (at === null || at.trim() === '') return;
    const done = await invoke(WORKTREE_HOOK_COMMANDS.testRun, {
      script: text,
      at: at.trim(),
      ...(scope === 'set' ? { repos: [...members] } : {}),
    });
    setStatus((was) => ({
      ...was,
      [scope]: done.ok ? 'test run ok' : `${done.error.code}: ${done.error.message}`,
    }));
  };

  const addMember = (candidate: string): void => {
    const trimmed = candidate.trim();
    // A set is a SET: the same repo twice is one member, and the store would
    // collapse it anyway — two chips for one member would be the editor
    // disagreeing with what it just saved.
    if (trimmed === '' || members.includes(trimmed)) return;
    setMembers([...members, trimmed]);
    setDraft('');
    setSuggestions([]);
  };

  const complete = async (query: string): Promise<void> => {
    if (query.trim() === '') {
      setSuggestions([]);
      return;
    }
    const found = await invoke('tasks.suggestRepos', { query });
    // A failure here is not worth a status line: completion is an assist, and
    // saying "suggestRepos failed" over a field somebody is typing into is
    // noise about a thing they did not ask for.
    setSuggestions(found.ok ? readPaths(found.value) : []);
  };

  return (
    <div className="sh-hook" data-testid="worktree-hook-editor">
      {/* --------------------------------------------------------- 1 · every repo */}
      <ScopeCard
        step={1}
        name="Every repo"
        env="$WORKTREE_DIR"
        status={status.global}
        onTestRun={() => void testRun('global', globalScript)}
        onSave={() => void save(undefined, globalScript)}
        primary={active === 'global'}
        saveTestId="worktree-hook-save-global"
      >
        {/*
          Body copy, not a `<label>`. It describes when the script runs, which is
          not what a field is called — and `.sh-ext-label` had no CSS rule anywhere,
          so these rendered at inherited body size and outweighed the cards holding
          them.
        */}
        <p className="sh-hook__purpose">Runs first, in every worktree.</p>
        <TextArea
          id={globalId}
          className="sh-hook__well"
          data-testid="worktree-hook-global"
          value={globalScript}
          onChange={(event) => {
            setGlobalScript(event.target.value);
            setActive('global');
          }}
          minLines={3}
          maxLines={10}
          placeholder="direnv allow"
        />
      </ScopeCard>

      {/* ----------------------------------------------------------- 2 · one repo */}
      <ScopeCard
        step={2}
        name="One repo"
        env="$WORKTREE_SRC → $WORKTREE_DIR"
        status={status.repo}
        onTestRun={() => void testRun('repo', script)}
        onSave={() => void save(path, script)}
        saveDisabled={path.trim() === ''}
        primary={active === 'repo'}
        saveTestId="worktree-hook-save-repo"
      >
        {/*
          The purpose and the repo, in the same two-track grid a settings row uses —
          so the path input lines up with the Selects on the other pages instead of
          being a third column width on the same screen.
        */}
        <div className="sh-hook__pair">
          <p className="sh-hook__purpose">Runs in that repo’s worktree.</p>
          <Field
            id={pathId}
            className="sh-hook__path"
            data-testid="worktree-hook-path"
            value={path}
            list={listId}
            placeholder="~/dev/alpha"
            onChange={(event) => {
              setPath(event.target.value);
              setActive('repo');
              void complete(event.target.value);
            }}
          />
        </div>
        <datalist id={listId}>
          {suggestions.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <TextArea
          id={scriptId}
          className="sh-hook__well"
          data-testid="worktree-hook-script"
          value={script}
          onChange={(event) => {
            setScript(event.target.value);
            setActive('repo');
          }}
          minLines={4}
          maxLines={14}
          placeholder='cp "$WORKTREE_SRC/.env" "$WORKTREE_DIR/.env"'
        />
      </ScopeCard>

      {/* ------------------------------------------------------ 3 · a set of repos */}
      <ScopeCard
        step={3}
        name="A set of repos"
        env="$TASK_ROOT"
        status={status.set ?? (members.length > 0 ? `${members.length} repos · not saved` : undefined)}
        onTestRun={() => void testRun('set', wiringScript)}
        onSave={() => void saveSet()}
        saveDisabled={members.length === 0}
        primary={active === 'set'}
        saveTestId="worktree-hook-save-set"
      >
        <p className="sh-hook__purpose">Runs once at the task root, when all of them are present.</p>
        {/*
          The members, as `Pill`s.

          This was the composer's own `sh-composer-picked` markup, borrowed by class
          from the renderer's shared stylesheet — the LOOK without the component,
          because one extension may not value-import another. `Pill` is the primitive
          that shape became, so the borrowing is over. The `<ul>`/`<li>` around them
          stays: a set is a list, and the `data-path` is how a test reads what the
          chips stand for.
        */}
        <div className="sh-hook__members-line">
          {/*
            The `+ repo` affordance is a SIBLING of this list, not an item in it.
            Inside the `<ul>` it counted as a member — `pickedPaths()` reads every
            `li`, and a set with two repos measured three.
          */}
          <ul className="sh-hook__members" data-testid="worktree-hook-set-picked">
            {members.map((member) => (
              <li key={member} data-path={member} title={member}>
                <Pill>
                  {nameOf(member)}
                  <button
                    type="button"
                    className="sh-hook__member-remove"
                    aria-label={`remove ${nameOf(member)}`}
                    title={`remove ${nameOf(member)}`}
                    onClick={() => setMembers(members.filter((candidate) => candidate !== member))}
                  >
                    ×
                  </button>
                </Pill>
              </li>
            ))}
          </ul>
          <div className="sh-hook__member-add">
            <Field
              id={setPathId}
              variant="bare"
              size="sm"
              data-testid="worktree-hook-set-path"
              value={draft}
              list={setListId}
              placeholder="+ repo"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setActive('set');
                void complete(event.target.value);
              }}
              onKeyDown={(event) => {
                // ⏎ adds the repo rather than submitting: a set with the field
                // half-typed is a set with the wrong repos. The composer's gesture,
                // and the one these chips were borrowed from.
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addMember(draft);
              }}
            />
          </div>
        </div>
        <datalist id={setListId}>
          {suggestions.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <TextArea
          id={setScriptId}
          className="sh-hook__well"
          data-testid="worktree-hook-set-script"
          value={wiringScript}
          onChange={(event) => {
            setWiringScript(event.target.value);
            setActive('set');
          }}
          minLines={4}
          maxLines={14}
          placeholder='ln -sf "$TASK_ROOT/alpha/dist" "$TASK_ROOT/beta/vendor/alpha"'
        />
      </ScopeCard>

      {/* ------------------------------------------------------------------ stored */}
      {(hooks.length > 0 || sets.length > 0) && (
        <div className="sh-hook__stored">
          <SectionLabel count={hooks.length + sets.length}>Stored</SectionLabel>
          <div data-testid="worktree-hook-list">
            {hooks.map((hook) => (
              <Row
                key={hook.path}
                className="sh-hook__stored-row"
                data-testid="worktree-hook-row"
                // Clicking loads it into the card above rather than editing in
                // place: there is one editor, and two would be two places for the
                // same script to disagree about itself.
                onClick={() => {
                  setPath(hook.path);
                  setScript(hook.script);
                  setActive('repo');
                  setSuggestions([]);
                }}
                meta={lineCount(hook.script)}
                actions={
                  <Button
                    type="button"
                    size="sm"
                    data-testid="worktree-hook-clear"
                    onClick={(event) => {
                      event.stopPropagation();
                      void save(hook.path, '');
                    }}
                  >
                    clear
                  </Button>
                }
              >
                {hook.path}
              </Row>
            ))}
          </div>
          <div data-testid="worktree-hook-set-list">
            {sets.map((hook) => (
              <Row
                key={hook.paths.join('\n')}
                className="sh-hook__stored-row"
                data-testid="worktree-hook-set-row"
                // Loads it into the card above, for the reason the repo rows do it
                // that way: there is one editor, and two would be two places for
                // the same script to disagree about itself.
                onClick={() => {
                  setMembers(hook.paths);
                  setWiringScript(hook.script);
                  setDraft('');
                  setActive('set');
                  setSuggestions([]);
                }}
                meta="set"
                actions={
                  <Button
                    type="button"
                    size="sm"
                    data-testid="worktree-hook-set-clear"
                    onClick={(event) => {
                      event.stopPropagation();
                      void invoke(WORKTREE_HOOK_COMMANDS.set, { repos: [...hook.paths], script: '' }).then(() =>
                        refresh(),
                      );
                    }}
                  >
                    clear
                  </Button>
                }
              >
                {hook.paths.map((member) => nameOf(member)).join(' + ')}
              </Row>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One scope: a card that says what it is, what its script can read, and what the
 * two things you can do with it are.
 *
 * The same treatment a spec page's group card has (`.sh-settings__group`), reused by
 * class rather than reimplemented — a contributed page and a kernel page should read
 * as the same app, and that is a claim about one stylesheet, not two.
 */
function ScopeCard({
  step,
  name,
  env,
  status,
  children,
  onTestRun,
  onSave,
  saveDisabled = false,
  primary,
  saveTestId,
}: {
  readonly step: number;
  readonly name: string;
  /** What this scope's script can read. The one thing a hook author had to guess. */
  readonly env: string;
  readonly status: string | undefined;
  readonly children: ReactNode;
  readonly onTestRun: () => void;
  readonly onSave: () => void;
  readonly saveDisabled?: boolean;
  /** Whether THIS card's save is the page's one primary. */
  readonly primary: boolean;
  readonly saveTestId: string;
}): ReactElement {
  return (
    <section className="sh-settings__group sh-hook__card">
      <div className="sh-settings__group-head">
        <span>
          {step} · {name}
        </span>
        <span className="sh-settings__group-status">{env}</span>
      </div>
      <div className="sh-hook__body">{children}</div>
      <div className="sh-hook__footer">
        <span className="sh-hook__status" data-testid="worktree-hook-status">
          {status ?? ''}
        </span>
        <span className="sh-hook__footer-spacer" />
        <Button type="button" size="sm" variant="default" onClick={onTestRun}>
          test run
        </Button>
        <Button
          type="button"
          size="sm"
          // Exactly one primary per surface (rule 3): the card being edited. Three
          // primaries is three "the main thing to do here", which is none.
          variant={primary ? 'primary' : 'default'}
          data-testid={saveTestId}
          disabled={saveDisabled}
          onClick={onSave}
        >
          save
        </Button>
      </div>
    </section>
  );
}
