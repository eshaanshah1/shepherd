import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { CodeView } from '@pierre/diffs/react';
import { processFile } from '@pierre/diffs';
import { Button, Empty, SectionLabel } from '@shepherd/ui';
import { GITHUB_COMMANDS } from '../src/manifest.ts';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_THEME } from './diff-theme.ts';

/**
 * What a task has changed, before there is a pull request to change it in.
 *
 * The view the rail's git icon opens on a task with no PR. It is NOT the Files
 * tab with a different source: that one is `DiffList`, which takes a
 * `PullRequest` and carries review threads through every branch of itself, and
 * feeding it a synthesised PR to show a working tree would be a lie told to a
 * component in order to reuse it. This draws the same `CodeView` with the same
 * registered theme and nothing else.
 *
 * Every diff here is `editor`'s answer, fetched by `github.changes`. "What have
 * I changed" is one question and the app answers it in one place.
 *
 * Measured in the task's WORKTREE and against the commit it forked from, which
 * is what makes the answer this task's rather than the user's own checkout's,
 * and what keeps it from emptying the moment an agent commits.
 */

/** One repo's working tree, as `github.changes` reports it. */
export interface RepoChanges {
  readonly name: string;
  readonly path: string;
  readonly branch: string | null;
  readonly base: string | null;
  readonly files: readonly { readonly path: string; readonly status: string; readonly patch: string }[];
  /** Why this repo cannot open a PR yet, or `null` if it can. */
  readonly refuse: string | null;
}

export function readChanges(value: unknown): readonly RepoChanges[] {
  if (typeof value !== 'object' || value === null) return [];
  const repos = (value as { repos?: unknown }).repos;
  if (!Array.isArray(repos)) return [];
  return repos.flatMap((entry): RepoChanges[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    // The path is the identifier `github.createPr` is addressed by; an invented
    // one would push somebody else's repo.
    if (typeof row['path'] !== 'string' || typeof row['name'] !== 'string') return [];
    const files = Array.isArray(row['files'])
      ? row['files'].flatMap((file): RepoChanges['files'][number][] => {
          if (typeof file !== 'object' || file === null) return [];
          const shape = file as Record<string, unknown>;
          return typeof shape['path'] === 'string' && typeof shape['patch'] === 'string'
            ? [
                {
                  path: shape['path'],
                  status: typeof shape['status'] === 'string' ? shape['status'] : 'modified',
                  patch: shape['patch'],
                },
              ]
            : [];
        })
      : [];
    return [
      {
        name: row['name'],
        path: row['path'],
        branch: typeof row['branch'] === 'string' ? row['branch'] : null,
        base: typeof row['base'] === 'string' ? row['base'] : null,
        files,
        refuse: typeof row['refuse'] === 'string' ? row['refuse'] : null,
      },
    ];
  });
}

type Invoke = (
  command: string,
  args?: unknown,
) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }>;

export interface WorkingChangesProps {
  readonly task: string;
  readonly signedIn: boolean;
  readonly invoke: Invoke;
}

export function WorkingChanges({ task, signedIn, invoke }: WorkingChangesProps): ReactElement {
  const [repos, setRepos] = useState<readonly RepoChanges[] | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [said, setSaid] = useState<string | undefined>(undefined);

  const load = useMemo(
    () => async (): Promise<void> => {
      const answer = await invoke(GITHUB_COMMANDS.changes, { task });
      setRepos(answer.ok ? readChanges(answer.value) : []);
    },
    [invoke, task],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (repo: RepoChanges): Promise<void> => {
    setBusy(repo.path);
    setSaid(undefined);
    const answer = await invoke(GITHUB_COMMANDS.createPr, { task, repo: repo.path });
    setBusy(undefined);
    const value = answer.ok ? (answer.value as { ok?: boolean; reason?: string }) : undefined;
    if (value?.ok === true) {
      // The sync redraws the pane into the PR list on its own; saying so is for
      // the moment before it does.
      setSaid(`Opened a pull request for ${repo.name}.`);
      return;
    }
    setSaid(value?.reason ?? 'could not open a pull request');
  };

  if (repos === undefined) return <Empty>Reading your changes…</Empty>;

  const dirty = repos.filter((repo) => repo.files.length > 0);
  if (dirty.length === 0) {
    return (
      <Empty hint="Anything this task changes — committed or not — shows up here.">
        No pull request yet, and nothing changed in this task’s worktrees.
      </Empty>
    );
  }

  return (
    <div className="sh-review__body">
      <div className="sh-review__scroll">
        {said === undefined ? null : (
          <p className="sh-changes__said" role="status">
            {said}
          </p>
        )}
        {dirty.map((repo) => (
          <section key={repo.path} className="sh-changes__repo">
            <header className="sh-changes__head">
              <SectionLabel count={String(repo.files.length)}>{repo.name}</SectionLabel>
              <span className="sh-changes__branch">{repo.branch ?? 'no branch'}</span>
              <span className="sh-changes__spacer" />
              {repo.refuse !== null ? (
                /*
                 * A reason rather than a disabled button: "nothing committed
                 * yet" is something the user can act on, and a greyed control
                 * says only that they cannot.
                 */
                <span className="sh-changes__refuse">{repo.refuse}</span>
              ) : !signedIn ? (
                <span className="sh-changes__refuse">not signed in to GitHub</span>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => void create(repo)}
                >
                  {busy === repo.path ? 'Opening…' : 'Create pull request'}
                </Button>
              )}
            </header>
            <Diffs repo={repo} />
          </section>
        ))}
      </div>
    </div>
  );
}

function Diffs({ repo }: { readonly repo: RepoChanges }): ReactElement {
  const items = useMemo(
    () =>
      repo.files.flatMap((file) => {
        const fileDiff = processFile(file.patch, {
          cacheKey: `${repo.path}:${file.path}`,
          isGitDiff: true,
        });
        if (fileDiff === undefined) return [];
        return [{ id: `${repo.path}:${file.path}`, type: 'diff' as const, fileDiff }];
      }),
    [repo],
  );

  return (
    <CodeView
      className="sh-pr-diff__view"
      items={items}
      options={{
        theme: SHEPHERD_DIFF_THEME,
        unsafeCSS: SHEPHERD_DIFF_CSS,
        // The same pair the Files tab settled on: unified so the column is not
        // halved, wrapped so a line ends where the pane does.
        diffStyle: 'unified',
        overflow: 'wrap',
      }}
      disableWorkerPool
    />
  );
}
