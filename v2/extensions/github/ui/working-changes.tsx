import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { CodeView } from '@pierre/diffs/react';
import { processFile } from '@pierre/diffs';
import { Button, Empty, Icon, SectionLabel, namedGlyph } from '@shepherd/ui';
import { GITHUB_COMMANDS } from '../src/manifest.ts';
import { ChangeMark, DiffSprite } from './pr-panels.tsx';
import type { ChangedFile } from '../src/model/index.ts';
import { SHEPHERD_DIFF_CSS, SHEPHERD_DIFF_SIZING, SHEPHERD_DIFF_THEME } from './diff-theme.ts';

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
 *
 * The worktrees are the ones under the task ROOT, which is not the same list as
 * the repos its record names — `src/worktrees.ts` says why that difference is
 * the whole point.
 */

/** One repo's working tree, as `github.changes` reports it. */
export interface RepoChanges {
  readonly name: string;
  /** The WORKTREE — where the diff was measured, and what a PR would push. */
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

/**
 * Why the command would not answer, when it would not.
 *
 * `github.changes` refuses with `{ ok: false, reason }` in the value, and
 * `readChanges` reads any such shape as no repos — which drew the same
 * "nothing changed" as a task that genuinely had nothing changed. A refusal
 * that renders as an answer is the worst of the two, because there is nothing
 * on screen to suggest looking further.
 */
export function readRefusal(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { ok?: unknown; reason?: unknown };
  return row.ok === false && typeof row.reason === 'string' ? row.reason : null;
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
  const [failed, setFailed] = useState<string | undefined>(undefined);
  /*
   * How many answers have arrived — the item `version` a fold is folded by.
   *
   * `CodeView` drops an item whose version has not moved, so without a number
   * that changes when the ANSWER changes, a reload that brought new patches
   * would be short-circuited by the same rule that makes folding work.
   */
  const [epoch, setEpoch] = useState(0);

  const load = useMemo(
    () => async (): Promise<void> => {
      const answer = await invoke(GITHUB_COMMANDS.changes, { task });
      if (!answer.ok) {
        setFailed('the changes could not be read');
        setRepos([]);
        return;
      }
      setFailed(readRefusal(answer.value) ?? undefined);
      setRepos(readChanges(answer.value));
      setEpoch((was) => was + 1);
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
    if (failed !== undefined) {
      return <Empty hint={failed}>This task’s changes could not be read.</Empty>;
    }
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
            <Diffs repo={repo} epoch={epoch} />
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * A worktree's status word in the vocabulary the mark and the counts speak.
 *
 * `editor`'s git says `deleted` and `untracked`; `ChangedFile` — GitHub's
 * spelling, which `ChangeMark` reads — says `removed` and has no word for a
 * file git has not been told about yet. An untracked file is an ARRIVAL, which
 * is what `added` means, and calling it an edit draws the ordinary mark over a
 * file that is entirely new.
 */
export function changedStatus(status: string): ChangedFile['status'] {
  switch (status) {
    case 'untracked':
    case 'added':
      return 'added';
    case 'deleted':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

/**
 * The files of one repo, each foldable by its own header.
 *
 * The header is OURS — `renderCustomHeader`, the same one the Files tab draws —
 * for two reasons that are one reason. The package's header has no chevron and
 * nothing to click, so a task with twenty changed files was twenty diffs to
 * scroll past rather than a list you could shut. And `SHEPHERD_DIFF_SIZING`
 * reserves 29px a header because that is `.sh-pr-diff__head` rendered, while
 * the package's own is 44 — drawing theirs against our metrics puts the
 * reserved boxes and the painted rows in different places.
 *
 * `version` is what makes a fold fold — see the longer note in `pr-panels.tsx`:
 * `CodeView` keeps a record per item id and short-circuits on an unchanged
 * version, so a new array with a flipped `collapsed` is dropped and only the
 * chevron turns. Its `epoch` half moves when the ANSWER moves, so a reload
 * redraws rather than being short-circuited the same way.
 */
function Diffs({ repo, epoch }: { readonly repo: RepoChanges; readonly epoch: number }): ReactElement {
  /*
   * Which files the user folded, and only those. Nothing here starts folded —
   * unlike the Files tab, where anything long does — so a set of paths says
   * everything there is to say.
   */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string): void =>
    setFolded((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const items = useMemo(
    () =>
      repo.files.flatMap((file) => {
        const fileDiff = processFile(file.patch, {
          cacheKey: `${repo.path}:${file.path}`,
          isGitDiff: true,
        });
        if (fileDiff === undefined) return [];
        const shut = folded.has(file.path);
        return [
          {
            id: `${repo.path}:${file.path}`,
            type: 'diff' as const,
            fileDiff,
            collapsed: shut,
            version: epoch * 2 + (shut ? 1 : 0),
          },
        ];
      }),
    [repo, folded, epoch],
  );

  /*
   * The counts the header shows, summed from the hunks the library already
   * parsed. `github.changes` carries a patch and a status and no numbers, and
   * counting the patch's own `+`/`-` lines again would be a second parser
   * disagreeing with the first over `+++` and `\ No newline`.
   */
  const counts = useMemo(() => {
    const rows = new Map<string, { readonly added: number; readonly removed: number }>();
    for (const item of items) {
      let added = 0;
      let removed = 0;
      for (const hunk of item.fileDiff.hunks) {
        added += hunk.additionLines;
        removed += hunk.deletionLines;
      }
      rows.set(item.id, { added, removed });
    }
    return rows;
  }, [items]);

  const byId = useMemo(
    () => new Map<string, RepoChanges['files'][number]>(repo.files.map((file) => [`${repo.path}:${file.path}`, file])),
    [repo],
  );

  return (
    <div className="sh-pr-diff">
      <DiffSprite />
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
          /*
           * The filename stays with the code it names. Six hundred lines in,
           * the header that says which file this is has long since scrolled
           * away, and the answer to "what am I reading" was to scroll back up.
           */
          stickyHeaders: true,
          ...SHEPHERD_DIFF_SIZING,
        }}
        disableWorkerPool
        renderCustomHeader={(item) => {
          const file = byId.get(item.id);
          if (file === undefined) return null;
          const shut = folded.has(file.path);
          const count = counts.get(item.id) ?? { added: 0, removed: 0 };
          return (
            <button
              type="button"
              className="sh-pr-diff__head sh-ui-focusable"
              aria-expanded={!shut}
              onClick={() => toggle(file.path)}
            >
              <Icon icon={namedGlyph(shut ? 'chevron-right' : 'chevron')} size="sm" />
              <ChangeMark
                file={{
                  path: file.path,
                  added: count.added,
                  removed: count.removed,
                  status: changedStatus(file.status),
                }}
              />
              <span className="sh-pr-diff__path">{file.path}</span>
              <span className="sh-pr-diff__count" data-tone="added">
                +{count.added}
              </span>
              <span className="sh-pr-diff__count" data-tone="removed">
                −{count.removed}
              </span>
            </button>
          );
        }}
      />
    </div>
  );
}
