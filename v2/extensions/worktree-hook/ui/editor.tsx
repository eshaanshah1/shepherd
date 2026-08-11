import { useEffect, useId, useState } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';
import { Button, Composer, Field, Row, SectionLabel, TextArea } from '@shepherd/ui';
import { WORKTREE_HOOK_COMMANDS } from '../src/manifest.ts';

/**
 * The hook editor — the whole surface for a feature that has no settings page
 * to live in yet.
 *
 * That is the only reason it exists as a view of its own, and the README says
 * so: when v2 grows a settings surface this belongs inside it and the overlay
 * should go. Until then, ⌘⇧H.
 *
 * Like the composer, it is a **consumer** and nothing more: React and four
 * command invocations, with every decision — what clears a hook, which paths
 * exist, whether a script is worth storing — on the other side of `invoke`. The
 * repo field completes through `tasks.suggestRepos`, borrowed rather than
 * reimplemented so that the repos you can hook and the repos you can put on a
 * task are the same set, spelled the same way.
 */

interface StoredHook {
  readonly path: string;
  readonly script: string;
}

/**
 * A command's answer is `unknown`, and a cast is not a check.
 *
 * It crossed an IPC boundary; reading `.length` off whatever arrived is how a
 * malformed answer takes the whole overlay down with a `TypeError`. Anything
 * that is not a well-formed hook is dropped rather than drawn.
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
 * malformed answer takes the whole overlay down with a `TypeError`.
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

export function WorktreeHookEditor({ invoke }: ExtensionViewProps): React.JSX.Element {
  const globalId = useId();
  const pathId = useId();
  const scriptId = useId();
  const listId = useId();

  const [globalScript, setGlobalScript] = useState('');
  const [hooks, setHooks] = useState<readonly StoredHook[]>([]);
  const [path, setPath] = useState('');
  const [script, setScript] = useState('');
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [status, setStatus] = useState('');

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
      setStatus(`${shown.error.code}: ${shown.error.message}`);
      return;
    }
    setGlobalScript(readScript(shown.value));
    setHooks(readHooks((shown.value as { repos?: unknown }).repos));
    setSets(readSets((shown.value as { sets?: unknown }).sets));
  };

  useEffect(() => {
    void refresh();
    // Once, on open. The overlay is unmounted when dismissed, so opening it
    // again is a fresh read rather than a stale one kept warm.
  }, []);

  const save = async (repo: string | undefined, text: string): Promise<void> => {
    const done = await invoke(
      WORKTREE_HOOK_COMMANDS.set,
      repo === undefined ? { script: text } : { repo, script: text },
    );
    if (!done.ok) {
      setStatus(`${done.error.code}: ${done.error.message}`);
      return;
    }
    // "saved" is a lie when the script was empty, and the difference matters:
    // clearing is a delete, and a person who typed nothing by accident should
    // be told the hook is gone rather than that it is stored.
    setStatus(text.trim() === '' ? `cleared ${repo ?? 'the global hook'}` : `saved ${repo ?? 'the global hook'}`);
    await refresh();
  };

  const saveSet = async (): Promise<void> => {
    const done = await invoke(WORKTREE_HOOK_COMMANDS.set, { repos: [...members], script: wiringScript });
    if (!done.ok) {
      setStatus(`${done.error.code}: ${done.error.message}`);
      return;
    }
    const label = members.map((path) => nameOf(path)).join(' + ');
    setStatus(wiringScript.trim() === '' ? `cleared ${label}` : `saved ${label}`);
    await refresh();
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
    <Composer data-testid="worktree-hook-editor">
      <SectionLabel>every repo</SectionLabel>
      <label className="sh-ext-label" htmlFor={globalId}>
        Runs first, in every worktree
      </label>
      <TextArea
        id={globalId}
        data-testid="worktree-hook-global"
        value={globalScript}
        onChange={(event) => setGlobalScript(event.target.value)}
        minLines={3}
        maxLines={10}
        placeholder="direnv allow"
      />
      <div className="sh-composer-controls">
        <span className="sh-composer-spacer" />
        <Button type="button" data-testid="worktree-hook-save-global" onClick={() => void save(undefined, globalScript)}>
          save global hook
        </Button>
      </div>

      <SectionLabel>one repo</SectionLabel>
      <label className="sh-ext-label" htmlFor={pathId}>
        Repo
      </label>
      <Field
        id={pathId}
        data-testid="worktree-hook-path"
        value={path}
        list={listId}
        placeholder="~/dev/alpha"
        onChange={(event) => {
          setPath(event.target.value);
          void complete(event.target.value);
        }}
      />
      <datalist id={listId}>
        {suggestions.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>

      <label className="sh-ext-label" htmlFor={scriptId}>
        Runs in that repo’s worktree
      </label>
      <TextArea
        id={scriptId}
        data-testid="worktree-hook-script"
        value={script}
        onChange={(event) => setScript(event.target.value)}
        minLines={4}
        maxLines={14}
        placeholder='cp "$WORKTREE_SRC/.env" "$WORKTREE_DIR/.env"'
      />
      <div className="sh-composer-controls">
        <span className="sh-composer-spacer" />
        <Button
          variant="primary"
          type="button"
          data-testid="worktree-hook-save-repo"
          disabled={path.trim() === ''}
          onClick={() => void save(path, script)}
        >
          save repo hook
        </Button>
      </div>

      <SectionLabel>a set of repos</SectionLabel>
      <label className="sh-ext-label" htmlFor={setPathId}>
        Repos
      </label>
      <Field
        id={setPathId}
        data-testid="worktree-hook-set-path"
        value={draft}
        list={setListId}
        placeholder="+ repo"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          void complete(event.target.value);
        }}
        onKeyDown={(event) => {
          // ⏎ adds the repo rather than submitting: a set with the field
          // half-typed is a set with the wrong repos. The composer's gesture, and
          // the one this field's chips are borrowed from.
          if (event.key !== 'Enter') return;
          event.preventDefault();
          addMember(draft);
        }}
      />
      <datalist id={setListId}>
        {suggestions.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>
      {/*
        The composer's own chip list, by class. `sh-composer-picked` lives in the
        renderer's shared stylesheet rather than in `tasks`, which is why this
        borrows the LOOK without borrowing the component — the composer's picker
        is woven into its own path-completion state, one extension may not
        value-import another, and this view's README says to delete it when the
        settings page lands.
      */}
      <ul className="sh-composer-picked" data-testid="worktree-hook-set-picked">
        {members.map((path) => (
          <li key={path} data-path={path} title={path}>
            {nameOf(path)}
            <button
              type="button"
              aria-label={`remove ${nameOf(path)}`}
              title={`remove ${nameOf(path)}`}
              onClick={() => setMembers(members.filter((candidate) => candidate !== path))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <label className="sh-ext-label" htmlFor={setScriptId}>
        Runs once at the task root, when all of them are present
      </label>
      <TextArea
        id={setScriptId}
        data-testid="worktree-hook-set-script"
        value={wiringScript}
        onChange={(event) => setWiringScript(event.target.value)}
        minLines={4}
        maxLines={14}
        placeholder='ln -sf "$TASK_ROOT/alpha/dist" "$TASK_ROOT/beta/vendor/alpha"'
      />
      <div className="sh-composer-controls">
        <span className="sh-composer-spacer" />
        <Button
          variant="primary"
          type="button"
          data-testid="worktree-hook-save-set"
          disabled={members.length === 0}
          onClick={() => void saveSet()}
        >
          save set hook
        </Button>
      </div>

      {hooks.length > 0 && (
        <>
          <SectionLabel count={hooks.length}>hooked repos</SectionLabel>
          <div data-testid="worktree-hook-list">
            {hooks.map((hook) => (
              <Row
                key={hook.path}
                data-testid="worktree-hook-row"
                // Clicking loads it into the fields above rather than editing in
                // place: there is one editor, and two would be two places for
                // the same script to disagree about itself.
                onClick={() => {
                  setPath(hook.path);
                  setScript(hook.script);
                  setSuggestions([]);
                }}
                actions={
                  <Button
                    type="button"
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
        </>
      )}

      {sets.length > 0 && (
        <>
          <SectionLabel count={sets.length}>hooked sets</SectionLabel>
          <div data-testid="worktree-hook-set-list">
            {sets.map((hook) => (
              <Row
                key={hook.paths.join('\n')}
                data-testid="worktree-hook-set-row"
                // Loads it into the fields above, for the reason the repo rows do
                // it that way: there is one editor, and two would be two places
                // for the same script to disagree about itself.
                onClick={() => {
                  setMembers(hook.paths);
                  setWiringScript(hook.script);
                  setDraft('');
                  setSuggestions([]);
                }}
                actions={
                  <Button
                    type="button"
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
                {hook.paths.map((path) => nameOf(path)).join(' + ')}
              </Row>
            ))}
          </div>
        </>
      )}

      <output className="sh-ext-answer" data-testid="worktree-hook-status">
        {status}
      </output>
    </Composer>
  );
}
