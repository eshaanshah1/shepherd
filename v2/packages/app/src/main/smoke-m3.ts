import { app, type BrowserWindow } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { runGit } from '@shepherd/platform-darwin';
import { flagValue } from './bootstrap.ts';
import { check, die, say, waiter } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

/**
 * M3: a task is real work on disk, and it survives being shelved.
 *
 * Driven through the **control socket**, not through the extension directly —
 * that is the transport the CLI and an agent use (§7b makes the CLI the agent
 * API), and a second path that happened to work would say nothing about the one
 * that ships. Same argument as `smoke:m2` posting real HTTP to `hooks.sock`.
 *
 * The one asserted SILENCE is creating a task: it is work the user asked for,
 * so it must not alert them about itself. M2's most valuable assertions were all
 * of that shape.
 */

export interface M3SmokeOptions extends M1SmokeOptions {
  readonly alerts: () => readonly unknown[];
}

export function isM3Options(options: Partial<M3SmokeOptions>): options is M3SmokeOptions {
  return typeof options.controlSocket === 'string' && typeof options.alerts === 'function';
}

export async function runM3Smoke(win: BrowserWindow, options: M3SmokeOptions): Promise<void> {
  const repo = flagValue(process.argv, '--shepherd-m3-repo');
  if (repo === undefined) die('no --shepherd-m3-repo');

  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({ command, args, caller: { kind: 'device', deviceId: 'local-cli' } });
    const raw = await post(options.controlSocket, body);
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  const until = waiter(60_000);

  // --- 1. create a task with a real repo, through the real transport.
  const created = (await invoke('tasks.create', {
    title: 'Smoke task',
    brief: 'Provisioned by the m3 smoke.',
    repos: [{ path: repo, name: 'api' }],
  })) as { id: string; slug: string };
  check(created.slug === 'smoke-task', `the slug is derived once: ${created.slug}`);

  // --- 2. provisioning is OPTIMISTIC, so the worktree lands after the answer.
  const listed = (await until(
    'the worktree to land',
    async () => ((await invoke('tasks.list')) as { id: string; root: string }[]).find((t) => t.id === created.id),
    (task) => task !== undefined && existsSync(join(task.root, 'api', '.git')),
  )) as { root: string };
  const worktree = join(listed.root, 'api');
  check(existsSync(join(listed.root, 'CLAUDE.md')), 'the generated CLAUDE.md exists');
  check(
    readFileSync(join(listed.root, 'CLAUDE.md'), 'utf8').includes('api/'),
    'the CLAUDE.md carries the repo map — the only one loaded at session start',
  );
  say('ok — the worktree and the task root are on disk');

  // --- 3. the silence: none of that alerted anybody.
  check(options.alerts().length === 0, `creating a task raised ${options.alerts().length} alert(s)`);
  say('ok — creating a task alerted nobody');

  // --- 4. dirty it in all four ways, then archive and restore.
  appendFileSync(join(worktree, 'README.md'), 'staged\n');
  await runGit('write', ['add', 'README.md'], { cwd: worktree, timeoutMs: 30_000 });
  appendFileSync(join(worktree, 'README.md'), 'unstaged\n');
  rmSync(join(worktree, 'gone.txt'));
  writeFileSync(join(worktree, 'scratch.txt'), 'untracked\n');
  const before = await status(worktree);
  check(before !== '', `the fixture is actually dirty: ${JSON.stringify(before)}`);

  await invoke('tasks.archive', { task: created.id });
  check(!existsSync(worktree), 'the worktree is gone after archiving');

  await invoke('tasks.restore', { task: created.id });
  const after = await until(
    'the work to be replayed',
    () => status(worktree),
    (text) => text === before,
  );
  check(after === before, `round trip: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  say('ok — the round trip is byte-identical');

  // --- 5. a contributed view is ON SCREEN, read from the real DOM.
  //
  // Asserting main's registry would pass even if the renderer never drew a
  // thing — the same reason m2 reads the badge's DOM rather than main's state.
  // Diagnostics contributes this tree; nothing about the dock knows that, which
  // is the property being tested.
  const rows = await until(
    'the contributed tree to render',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-view-type="diagnostics.tree"] [data-testid="view-row"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.length > 0,
  );
  check(rows.some((row) => row.includes('ticks')), `the tree's rows reached the DOM: ${JSON.stringify(rows)}`);
  say('ok — an extension put a view on screen');

  say('smoke: OK m3');
  app.exit(0);
}

async function status(cwd: string): Promise<string> {
  const out = await runGit('read', ['status', '--porcelain'], { cwd, timeoutMs: 30_000 });
  return out.ok ? out.stdout.split('\n').filter((l) => l !== '').sort().join('|') : '';
}

function post(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: '/invoke', method: 'POST', headers: { 'content-type': 'application/json' } },
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
