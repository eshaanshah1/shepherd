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

  const refresh = async (): Promise<void> => {
    const shown = await invoke(WORKTREE_HOOK_COMMANDS.get, {});
    if (!shown.ok) {
      setStatus(`${shown.error.code}: ${shown.error.message}`);
      return;
    }
    setGlobalScript(readScript(shown.value));
    setHooks(readHooks((shown.value as { repos?: unknown }).repos));
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

      <output className="sh-ext-answer" data-testid="worktree-hook-status">
        {status}
      </output>
    </Composer>
  );
}
