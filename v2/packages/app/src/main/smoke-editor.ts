import { app, type BrowserWindow } from 'electron';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { flagValue } from './bootstrap.ts';
import { check, die, say } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

/**
 * The editor: a real repo's files, read and written through the real registry.
 *
 * Driven through the **control socket**, not the extension directly — that is
 * the transport the CLI and an agent use, and a second path that happened to
 * work would say nothing about the one that ships. Same argument `smoke:m3`
 * makes.
 *
 * Every hop here is unit-tested and none of those tests spans it. What this
 * closes, specifically:
 *
 *   - the two `git ls-files` invocations are run by the real `gitRead`, in a
 *     real repo, so the ignored-FILE / ignored-DIRECTORY line is asserted
 *     against git rather than against a captured string;
 *   - the stale-save refusal crosses a real IPC port, where `stale` has to
 *     survive being serialised as a `reason` rather than thrown;
 *   - and the extension is proven to be COMPILED IN. Registering a manifest
 *     without adding the module to `builtins.ts` produces an app that boots,
 *     logs one line among hundreds, and is missing the feature — which is
 *     exactly how this extension's first build shipped, and how
 *     `worktree-hook`'s did before it.
 */

export type EditorSmokeOptions = M1SmokeOptions;

export async function runEditorSmoke(
  _win: BrowserWindow,
  options: EditorSmokeOptions,
): Promise<void> {
  const repo = flagValue(process.argv, '--shepherd-editor-repo');
  if (repo === undefined) die('no --shepherd-editor-repo');

  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({
      command,
      args,
      caller: { kind: 'device', deviceId: 'local-cli' },
    });
    const raw = await post(options.controlSocket, body);
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      value?: unknown;
      error?: { message?: string };
    };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  // --- 1. the tree, from a real repo through real git.

  const tree = (await invoke('editor.tree', { root: repo })) as {
    paths: readonly string[];
    status: readonly { path: string; status: string }[];
    truncated: boolean;
  };

  /*
   * The decision this whole extension turns on, asserted against git itself.
   * `.env` is ignored AND is very often the file the editor was opened to
   * change; `node_modules` is ignored and must never be enumerated, because
   * `useFileTree` holds its paths in full.
   */
  check(tree.paths.includes('src/app.ts'), 'the tree lists a tracked file');
  check(tree.paths.includes('untracked.ts'), 'the tree lists an untracked file');
  check(tree.paths.includes('.env'), 'the tree lists an IGNORED FILE — .env is editable');
  check(
    !tree.paths.some((path) => path.startsWith('node_modules')),
    'the tree lists no part of an ignored DIRECTORY',
  );
  check(!tree.truncated, 'a small repo is not reported as truncated');

  const marks = new Map(tree.status.map((entry) => [entry.path, entry.status]));
  check(marks.get('src/app.ts') === 'modified', 'a modified file carries its mark');
  check(marks.get('untracked.ts') === 'untracked', 'an untracked file carries its mark');

  // --- 2. a read, and the stamp a save is checked against.

  const read = (await invoke('editor.read', { root: repo, path: 'src/app.ts' })) as {
    text: string;
    stamp: { mtimeMs: number; size: number };
  };
  check(read.text.includes('changed'), 'the read answered the working copy');

  // --- 3. a save, through the port.

  await invoke('editor.write', {
    root: repo,
    path: 'src/app.ts',
    text: 'export const app = "saved by the smoke";\n',
    stamp: read.stamp,
  });
  check(
    readFileSync(join(repo, 'src/app.ts'), 'utf8').includes('saved by the smoke'),
    'a save with a current stamp reached the disk',
  );

  // --- 4. the refusal. The case this pane exists inside of.

  const fresh = (await invoke('editor.read', { root: repo, path: 'src/app.ts' })) as {
    stamp: { mtimeMs: number; size: number };
  };
  /*
   * Somebody else — an agent, in the case this is modelling — writes the file
   * between our read and our save. The mtime is forced rather than slept for:
   * two writes inside one filesystem tick can carry the same timestamp, which
   * is a real race and not one a smoke should roll dice on.
   */
  writeFileSync(join(repo, 'src/app.ts'), 'export const app = "AGENT WROTE THIS";\n');
  const later = new Date(fresh.stamp.mtimeMs + 5_000);
  utimesSync(join(repo, 'src/app.ts'), later, later);

  const refused = (await invoke('editor.write', {
    root: repo,
    path: 'src/app.ts',
    text: 'export const app = "clobbered";\n',
    stamp: fresh.stamp,
  })) as { ok?: boolean; reason?: string };

  check(refused.ok === false && refused.reason === 'stale', 'a stale save is REFUSED, by that name');
  check(
    readFileSync(join(repo, 'src/app.ts'), 'utf8').includes('AGENT WROTE THIS'),
    'the refusal left the other writer’s work on disk',
  );

  // --- 5. a diff, including the untracked case `--no-index` covers.

  const tracked = (await invoke('editor.diff', {
    root: repo,
    path: 'src/app.ts',
    untracked: false,
  })) as { patch: string | null };
  check(
    tracked.patch !== null && tracked.patch.includes('diff --git'),
    'a tracked file diffs against HEAD',
  );

  /*
   * `git diff --no-index` exits 1 when there ARE differences, which for an
   * untracked file is always — so this is the assertion that the exit status is
   * being read as data rather than as failure. Without it, no new file ever
   * renders in the changes view.
   */
  const untracked = (await invoke('editor.diff', {
    root: repo,
    path: 'untracked.ts',
    untracked: true,
  })) as { patch: string | null };
  check(
    untracked.patch !== null && untracked.patch.includes('new file mode'),
    'an untracked file diffs from /dev/null despite git exiting 1',
  );

  // --- 6. the Notes root: the scratchpad, in the same tree.

  const made = (await invoke('scratch.create', {})) as { id?: string };
  if (typeof made.id !== 'string') die('scratch.create answered no id');
  await invoke('scratch.write', { id: made.id, text: '# Deploy checks\n\nbody\n' });

  const withNote = (await invoke('editor.tree', { root: repo })) as { paths: readonly string[] };
  check(
    withNote.paths.some((path) => path.startsWith('Notes/Deploy checks')),
    'a live scratch document appears under the tree’s Notes root',
  );

  // --- 7. saveAs: the moment a note stops being a note.

  await invoke('scratch.saveAs', { id: made.id, root: repo, path: 'docs/deploy.md' });
  check(
    readFileSync(join(repo, 'docs/deploy.md'), 'utf8').includes('Deploy checks'),
    'saveAs wrote the note into the repo, creating its parent directory',
  );

  const after = (await invoke('editor.tree', { root: repo })) as { paths: readonly string[] };
  check(
    !after.paths.some((path) => path.startsWith('Notes/Deploy checks')),
    'and the note left the Notes root, because it has a path now',
  );
  check(after.paths.includes('docs/deploy.md'), 'the saved note is a file in the tree');

  /*
   * --- 8. the same pane, opened on a SUBDIRECTORY.
   *
   * The case that shipped broken while every check above passed: `git ls-files`
   * reports paths relative to the CWD and `git status --porcelain` relative to
   * the REPOSITORY ROOT, so a pane below the root had a tree in one vocabulary
   * and marks in another — no mark matched a row, the changed-file list grew a
   * phantom parent, and every diff asked git about a path that does not exist
   * from there. A fixture rooted only at the repo root cannot see any of it,
   * because the prefix is empty exactly there.
   */
  const sub = flagValue(process.argv, '--shepherd-editor-sub');
  if (sub === undefined) die('no --shepherd-editor-sub');

  const below = (await invoke('editor.tree', { root: sub })) as {
    paths: readonly string[];
    status: readonly { path: string; status: string }[];
  };
  check(below.paths.includes('lib.ts'), 'a subdirectory’s tree is relative to that directory');
  check(
    !below.paths.some((path) => path.startsWith('pkg/')),
    'and carries no phantom parent from the repo root',
  );

  const belowMarks = new Map(below.status.map((entry) => [entry.path, entry.status]));
  check(belowMarks.get('lib.ts') === 'modified', 'a mark lands on the row it belongs to');
  check(belowMarks.get('fresh.ts') === 'untracked', 'including an untracked one');
  check(
    !below.status.some((entry) => entry.path.startsWith('src/')),
    'a change outside the pane’s directory is not listed in it',
  );

  const belowDiff = (await invoke('editor.diff', {
    root: sub,
    path: 'lib.ts',
    untracked: false,
  })) as { patch: string | null };
  check(belowDiff.patch !== null, 'and a file below the root actually diffs');

  say('editor: done');
  app.quit();
}

function post(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/invoke',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
