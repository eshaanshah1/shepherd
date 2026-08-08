import { useEffect, useState } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';
import { repoName } from '../src/model/repo-name.ts';

/**
 * The composer — a task, created from inside the app (sketch §4).
 *
 * It is a **consumer** of the component view kind (ADR 0033) and nothing else:
 * every line below is React and two command invocations, and the core knows
 * none of it. That is the same test P6b's task tree had to pass — if a form had
 * needed a special case in the shell, the §2b bar would have been missed, and
 * the shell would now contain the words "title", "brief" and "repo".
 *
 * Three things it deliberately does not do:
 *
 *   - It does not rank repos. `tasks.suggestRepos` asks the extension, which
 *     asks the `tasks.repoSuggestions` point (D5) — so replacing the ranking
 *     stays a registration rather than a fork of this file.
 *   - It does not provision anything, or know that provisioning exists.
 *     `tasks.create` returns as soon as the record does (D12), and the worktrees
 *     land behind it; the tree reports their progress, because that is the view
 *     whose job is state.
 *   - It cannot say who it is. `invoke` carries no caller — main attributes the
 *     call to `shepherd.tasks`, which is what stops an extension's own UI from
 *     borrowing the user's unconditional trust (D14).
 */

interface RepoSuggestion {
  readonly path: string;
  readonly name: string;
}

/**
 * A command's answer is `unknown`, and a cast is not a check.
 *
 * It has crossed an IPC boundary and been through a provider this file has
 * never seen — a third-party one, by design (D5). Casting the value and reading
 * `.length` off it is how a suggestion provider that answers `undefined` takes
 * the whole composer down with a `TypeError`, which is what the first run of
 * this component's own test did.
 */
function readSuggestions(value: unknown): readonly RepoSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, name } = entry as { path?: unknown; name?: unknown };
    if (typeof path !== 'string' || path === '') return [];
    return [{ path, name: typeof name === 'string' && name !== '' ? name : repoName(path) }];
  });
}

export function TaskComposer({ invoke }: ExtensionViewProps): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [repos, setRepos] = useState<readonly RepoSuggestion[]>([]);
  const [path, setPath] = useState('');
  const [suggestions, setSuggestions] = useState<readonly RepoSuggestion[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const askForSuggestions = async (forTitle: string, forBrief: string): Promise<void> => {
    const answer = await invoke('tasks.suggestRepos', { title: forTitle, brief: forBrief });
    if (answer.ok) setSuggestions(readSuggestions(answer.value));
  };

  // On mount, and again when the user finishes typing a field (`onBlur`), never
  // per keystroke: the point's providers may be doing real work, and a
  // keystroke-rate ask would make somebody else's provider the reason typing is
  // slow. There is no debounce because there is no timer here to get wrong.
  // Mount only — later asks are the blur handlers'.
  useEffect(() => {
    void askForSuggestions('', '');
  }, []);

  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed === '') return;
    // Same repo twice is one worktree and one branch, so it is one entry.
    if (repos.some((repo) => repo.path === trimmed)) return;
    setRepos([...repos, { path: trimmed, name: repoName(trimmed) }]);
    setPath('');
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    const result = await invoke('tasks.create', {
      title,
      brief,
      repos: repos.map((repo) => ({ path: repo.path, name: repo.name })),
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(`${result.error.code}: ${result.error.message}`);
      return;
    }
    const created = typeof result.value === 'object' && result.value !== null ? (result.value as { slug?: unknown }) : {};
    setStatus(`created ${typeof created.slug === 'string' ? created.slug : 'a task'}`);
    // Cleared only on success. A failed create keeps everything typed — the
    // form is the only copy of it.
    setTitle('');
    setBrief('');
    setRepos([]);
  };

  return (
    <form
      className="sh-ext-card"
      data-testid="task-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <h2 className="sh-dock-title">new task</h2>
      <input
        data-testid="composer-title"
        aria-label="task title"
        placeholder="what is this task"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void askForSuggestions(title, brief)}
      />
      <textarea
        data-testid="composer-brief"
        aria-label="task brief"
        placeholder="the brief the orchestrator starts from"
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        onBlur={() => void askForSuggestions(title, brief)}
      />

      <div className="sh-composer-repos">
        <input
          data-testid="composer-repo-path"
          aria-label="repo path"
          placeholder="/path/to/repo"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the repo rather than submitting the form: a task with
            // the repo field half-typed is a task with the wrong repos.
            if (event.key === 'Enter') {
              event.preventDefault();
              add(path);
            }
          }}
        />
        <button type="button" data-testid="composer-add-repo" onClick={() => add(path)}>
          add repo
        </button>
      </div>

      {suggestions.length > 0 && (
        <ul className="sh-composer-suggestions">
          {suggestions.map((suggestion) => (
            <li key={suggestion.path}>
              <button
                type="button"
                data-testid="composer-suggestion"
                data-path={suggestion.path}
                onClick={() => add(suggestion.path)}
              >
                {suggestion.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="sh-composer-picked" data-testid="composer-picked">
        {repos.map((repo) => (
          <li key={repo.path} data-testid="composer-picked-repo" data-path={repo.path}>
            {repo.name}
            <button type="button" onClick={() => setRepos(repos.filter((r) => r.path !== repo.path))}>
              remove
            </button>
          </li>
        ))}
      </ul>

      <button type="submit" data-testid="composer-create" disabled={busy || title.trim() === ''}>
        create task
      </button>
      <output className="sh-ext-answer" data-testid="composer-status">
        {status}
      </output>
    </form>
  );
}
